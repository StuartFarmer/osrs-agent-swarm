import tempfile
import unittest
from pathlib import Path

from collect_hiscore_names import NameCollector, parse_page, normalize_name


def page(names, next_page=None):
    links = '<a href="overall?table=0">Overall</a><a href="overall?category_type=1&amp;table=7">Boss</a>'
    links += ''.join(f'<a href="hiscorepersonal?user1={name}">{name}</a>' for name in names)
    if next_page:
        links += f'<a href="overall?table=0&amp;page={next_page}">Next</a>'
    return '<html><h1>Hiscores</h1>' + links + '</html>'


class CollectorTests(unittest.TestCase):
    def test_categories_names_and_pagination(self):
        result = parse_page(page(['Zezima', 'Some&nbsp;Name'], 2), 0, 0, 1)
        self.assertEqual(result.names, [('zezima', 'Zezima'), ('some_name', 'Some Name')])
        self.assertEqual(result.categories, {(0, 0): 'Overall', (1, 7): 'Boss'})
        self.assertTrue(result.has_next)
        self.assertEqual(normalize_name('Some-Name'), 'some_name')
        self.assertEqual(normalize_name('a__b'), 'a__b')
        self.assertIsNone(normalize_name('longer than twelve'))

    def test_blocked_or_changed_html_is_not_completion(self):
        for html in ['<html>Access denied</html>', '<html>Just a moment...</html>', '<h1>Hiscores</h1>']:
            with self.assertRaises(ValueError):
                parse_page(html, 0, 0, 1)
        self.assertEqual(parse_page(page(['Captcha']), 0, 0, 1).names, [('captcha', 'Captcha')])

    def test_resume_deduplicates_and_tracks_each_category(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'names.sqlite'
            with NameCollector(path) as c:
                c.save_page(0, 0, 1, page(['Alice', 'Bob'], 2))
                self.assertEqual(c.status()['names'], 2)
                self.assertEqual(c.next_page(), (1, 7, 1))
            with NameCollector(path) as c:
                c.save_page(1, 7, 1, page(['ALICE', 'Carol']))
                c.save_page(0, 0, 2, page(['Bob', 'Dave']))
                self.assertEqual(c.status()['names'], 4)
                self.assertTrue(c.status()['complete'])
                self.assertIsNone(c.next_page())

    def test_repeated_page_is_not_silently_crawled_forever(self):
        with tempfile.TemporaryDirectory() as root, NameCollector(Path(root) / 'names.sqlite') as c:
            c.save_page(0, 0, 1, page(['Alice'], 2))
            with self.assertRaisesRegex(ValueError, 'repeated'):
                c.save_page(0, 0, 2, page(['Alice'], 3))
            self.assertEqual(c.db.execute('select next_page from categories where kind=0 and table_id=0').fetchone()[0], 2)


if __name__ == '__main__':
    unittest.main()
