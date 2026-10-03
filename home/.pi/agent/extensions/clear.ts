import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Start a new session (alias of /new)",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });
}
