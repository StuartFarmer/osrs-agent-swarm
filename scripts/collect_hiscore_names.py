"""Resume a sequential crawl of every category in the main OSRS hiscores.

Standard library only. Names are public display names, not account identities.
"""
import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sqlite3
import time
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen

BASE = 'https://secure.runescape.com/m=hiscore_oldschool/'


def normalize_name(name):
    name = name.replace('\xa0', ' ').strip()
    if not re.fullmatch(r'[A-Za-z0-9 _-]{1,12}', name):
        return None
    # Same base-37 normalization as the pinned game: preserve interior separators.
    return re.sub(r'[^a-z0-9]', '_', name.lower()).strip('_') or None


class Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []
        self.current = None

    def handle_starttag(self, tag, attrs):
        if tag in ('a', 'option'):
            values = dict(attrs)
            self.current = [values.get('href') or values.get('value') or '', []]

    def handle_data(self, data):
        if self.current is not None:
            self.current[1].append(data)

    def handle_endtag(self, tag):
        if tag in ('a', 'option') and self.current is not None:
            self.links.append((self.current[0], ''.join(self.current[1]).replace('\xa0', ' ').strip()))
            self.current = None


@dataclass
class ParsedPage:
    names: list
    categories: dict
    has_next: bool


def parse_page(html, kind, table_id, page_number):
    if re.search(r'access denied|temporarily blocked|verify you are human|just a moment|complete the captcha|captcha challenge', html, re.I):
        raise ValueError('Hiscores access blocked; checkpoint retained, no bypass attempted')
    parser = Links()
    parser.feed(html)
    names, categories, page_links = {}, {}, []
    for href, label in parser.links:
        url = urlsplit(urljoin(BASE, href))
        if url.netloc != 'secure.runescape.com' or not url.path.startswith('/m=hiscore_oldschool/'):
            continue
        query = parse_qs(url.query)
        if url.path.rsplit('/', 1)[-1] in ('hiscorepersonal', 'hiscorepersonal.ws') and 'user1' in query:
            display = label or query['user1'][0]
            normalized = normalize_name(display)
            if normalized:
                names.setdefault(normalized, display)
        if url.path.rsplit('/', 1)[-1] not in ('overall', 'overall.ws') or 'table' not in query:
            continue
        try:
            category = (int(query.get('category_type', ['0'])[0]), int(query['table'][0]))
            page = int(query.get('page', ['1'])[0])
        except ValueError:
            continue
        if category[0] not in (0, 1) or category[1] < 0 or page < 1:
            continue
        if 'page' not in query:
            categories[category] = label or f'{category[0]}:{category[1]}'
        if category == (kind, table_id) and 'page' in query:
            page_links.append(page)
    if not names:
        raise ValueError('No recognizable player rows; not marking this category complete')
    if page_number == 1 and len(names) >= 25 and not page_links:
        raise ValueError('Full leaderboard page has no recognized pagination; inspect the HTML')
    if kind == 0 and table_id == 0 and page_number == 1 and len(categories) < 2:
        raise ValueError('Category discovery failed; not claiming coverage of all categories')
    return ParsedPage(list(names.items()), categories, any(p > page_number for p in page_links))


class NameCollector:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=30)
        self.db.executescript('''
          PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS names(name_key TEXT PRIMARY KEY, display_name TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS categories(kind INTEGER, table_id INTEGER, label TEXT,
            next_page INTEGER NOT NULL DEFAULT 1, done INTEGER NOT NULL DEFAULT 0, fetched_at TEXT,
            PRIMARY KEY(kind,table_id));
          CREATE TABLE IF NOT EXISTS pages(kind INTEGER, table_id INTEGER, page INTEGER,
            names_hash TEXT NOT NULL, fetched_at TEXT NOT NULL, url TEXT NOT NULL,
            PRIMARY KEY(kind,table_id,page));
          INSERT OR IGNORE INTO categories(kind,table_id,label) VALUES(0,0,'Overall');
        ''')
        self.db.commit()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.db.close()

    def next_page(self):
        return self.db.execute('SELECT kind,table_id,next_page FROM categories WHERE done=0 ORDER BY fetched_at,kind,table_id LIMIT 1').fetchone()

    def save_page(self, kind, table_id, page, html):
        parsed = parse_page(html, kind, table_id, page)
        digest = hashlib.sha256(json.dumps(parsed.names).encode()).hexdigest()
        previous = self.db.execute('SELECT names_hash FROM pages WHERE kind=? AND table_id=? AND page=?', (kind, table_id, page - 1)).fetchone()
        if previous and previous[0] == digest:
            raise ValueError('Server repeated the preceding page; checkpoint retained')
        now = datetime.now(timezone.utc).isoformat()
        with self.db:
            for (category_kind, category_table), label in parsed.categories.items():
                self.db.execute('INSERT OR IGNORE INTO categories(kind,table_id,label) VALUES(?,?,?)', (category_kind, category_table, label))
            self.db.executemany('INSERT OR IGNORE INTO names VALUES(?,?)', parsed.names)
            self.db.execute('INSERT INTO pages VALUES(?,?,?,?,?,?)', (kind, table_id, page, digest, now, page_url(kind, table_id, page)))
            self.db.execute('UPDATE categories SET next_page=?,done=?,fetched_at=? WHERE kind=? AND table_id=?', (page + 1, not parsed.has_next, now, kind, table_id))

    def status(self):
        names = self.db.execute('SELECT count(*) FROM names').fetchone()[0]
        pages = self.db.execute('SELECT count(*) FROM pages').fetchone()[0]
        total, done = self.db.execute('SELECT count(*),coalesce(sum(done),0) FROM categories').fetchone()
        return dict(names=names, pages=pages, categories=total, categories_complete=done, complete=total == done)


def page_url(kind, table_id, page):
    return BASE + 'overall?' + urlencode(dict(category_type=kind, table=table_id, page=page))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', default='.local/hiscores/names.sqlite')
    parser.add_argument('--max-pages', type=int, help='Optional page limit for this invocation; rerun to resume')
    parser.add_argument('--delay', type=float, default=2.0, help='Seconds between requests (minimum 2)')
    parser.add_argument('--user-agent', default='osrs-bot-swarm/0.1 (local research name collector)')
    parser.add_argument('--status', action='store_true')
    args = parser.parse_args()
    if args.delay < 2 or (args.max_pages is not None and args.max_pages < 1):
        parser.error('delay must be at least 2 seconds and max-pages must be positive')
    with NameCollector(args.database) as collector:
        if args.status:
            print(json.dumps(collector.status(), indent=2))
            return
        fetched = 0
        try:
            while (item := collector.next_page()) is not None:
                if args.max_pages is not None and fetched >= args.max_pages:
                    break
                if fetched:
                    time.sleep(args.delay)
                req = Request(page_url(*item), headers={'User-Agent': args.user_agent, 'Accept': 'text/html'})
                with urlopen(req, timeout=30) as response:
                    if not response.headers.get_content_type() == 'text/html':
                        raise ValueError('Unexpected content type; checkpoint retained')
                    html = response.read(4 * 1024 * 1024 + 1)
                    if len(html) > 4 * 1024 * 1024:
                        raise ValueError('Unexpectedly large page; checkpoint retained')
                    html = html.decode(response.headers.get_content_charset() or 'utf-8', errors='replace')
                collector.save_page(*item, html)
                fetched += 1
                print(json.dumps(dict(page=item, **collector.status())), flush=True)
        except HTTPError as error:
            # Stop rather than retry against a block or throttle. The next invocation resumes.
            raise SystemExit(f'Hiscores HTTP {error.code}; checkpoint retained. Retry-After: {error.headers.get("Retry-After", "not supplied")}') from None
        except KeyboardInterrupt:
            print('Stopped; checkpoint retained.')
        except (OSError, ValueError) as error:
            raise SystemExit(f'{error}; checkpoint retained') from None
        print(json.dumps(collector.status(), indent=2))


if __name__ == '__main__':
    main()
