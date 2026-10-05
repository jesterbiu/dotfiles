import { dirname } from 'node:path';

export function errorText(value) {
  return String(value)
    .replace(/\b(?:https?|wss?):\/\/[^\s]+/gi, '[redacted URL]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 300);
}

export function compactTask(task) {
  const result = { taskId: task.taskId, process: task.status ?? 'unknown', artifacts: task.metadataPath ? dirname(task.metadataPath) : task.artifacts };
  if (task.exitCode != null) result.exitCode = task.exitCode;
  if (task.exitSignal) result.exitSignal = task.exitSignal;
  if (task.reason) result.reason = errorText(task.reason);
  if (task.deadline != null) result.deadline = new Date(task.deadline).toISOString();
  if (task.statusReport) result.statusReport = task.statusReport;
  if (task.error) result.error = errorText(task.error.cause ?? task.error.message ?? task.error);
  return result;
}

export function compactError(error) {
  const result = { error: errorText(error.cause?.message ?? error.cause ?? error.message ?? error.error ?? error) };
  for (const key of ['action', 'taskId', 'messageId', 'delivery']) if (error[key] != null) result[key] = error[key];
  const artifacts = error.artifactDir ?? error.artifacts ?? (error.metadataPath ? dirname(error.metadataPath) : undefined);
  if (artifacts) result.artifacts = artifacts;
  if (error.sideEffects?.length) result.sideEffects = error.sideEffects.map(errorText);
  return result;
}

export function compactResponse(value) {
  if (value.tasks || value.results) {
    const key = value.tasks ? 'tasks' : 'results';
    return { [key]: value[key].map(compactTask), ...(value.errors?.length ? { errors: value.errors.map(compactError) } : {}) };
  }
  return compactTask(value);
}
