export class LiveTasks {
  constructor() {
    this.tasks = new Map();
    this.terminated = new Set();
  }

  update(task, completion = false) {
    if (this.terminated.has(task.taskId)) return false;
    const previous = this.tasks.get(task.taskId);
    const value = { ...previous, ...task };
    if (completion || (value.process != null && value.process !== 'running') || value.phase === 'terminated' || value.endedAt != null || value.observedAt != null) {
      this.terminated.add(task.taskId);
      return this.tasks.delete(task.taskId);
    }
    if (previous && Object.keys(value).every(key => value[key] === previous[key])) return false;
    this.tasks.set(task.taskId, value);
    return true;
  }

  values() {
    return [...this.tasks.values()].map(task => ({ ...task }));
  }
}
