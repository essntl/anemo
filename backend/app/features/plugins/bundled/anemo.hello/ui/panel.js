// Counts the open tasks (the tasks:read permission) and says so.
anemo.ready.then(async () => {
  const { tasks } = await anemo.call('tasks.list', { status: 'todo' })
  document.getElementById('out').textContent = `Hello: ${tasks.length} open tasks`
})
