import type { NotifierAdapter } from "@openconfer/adapter-sdk";

export function createSecureLinkNotifier(): NotifierAdapter {
  return {
    name: "secure_link",
    async notify(session, joinUrl) {
      return {
        success: true,
        channel: "secure_link",
        joinUrl,
        message: `Confer session ${session.id}: ${joinUrl}`,
      };
    },
    async test() {
      return { ok: true, message: "Secure link notifier ready" };
    },
  };
}
