process.on("message", (message: any) => {
  if (message.method === "spin") while (true) {}
  if (message.method === "echo")
    process.send?.({ id: message.id, value: message.params });
});
