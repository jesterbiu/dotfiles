import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createPiRuntime(manifest) {
  const sdk = await import(pathToFileURL(manifest.sdkPath).href);
  const { cwd, agentDir, dir } = manifest;
  const create = async ({ sessionManager, sessionStartEvent }) => {
    const services = await sdk.createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager: sdk.SettingsManager.inMemory({ packages: [], extensions: [], cacheWarming: 'off' }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPromptOverride: () => undefined,
        appendSystemPromptOverride: () => ['You are a delegated subagent. Work on the assigned task and return a concise result with relevant file paths. Your working directory is shared with other agents. Follow the assigned write scope. Do not launch other agents or background work.'],
      },
    });
    const model = services.modelRuntime.getModel(manifest.model.provider, manifest.model.id);
    if (!model) throw new Error(`Child model is unavailable: ${manifest.model.provider}/${manifest.model.id}. Runtime-only parent providers are not inherited.`);
    return {
      ...(await sdk.createAgentSessionFromServices({
        services, sessionManager, sessionStartEvent, model, thinkingLevel: manifest.thinkingLevel,
        tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
      })),
      services,
    };
  };
  const runtime = await sdk.createAgentSessionRuntime(create, {
    cwd, agentDir, sessionManager: sdk.SessionManager.create(cwd, join(dir, 'sessions')),
  });
  try {
    await runtime.session.bindExtensions({ mode: 'json', onError: error => console.error(JSON.stringify(error)) });
    return runtime;
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
