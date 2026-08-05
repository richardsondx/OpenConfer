import type { NotifierAdapter } from "@openconfer/adapter-sdk";

/**
 * Web push is post-MVP.
 * Secure-link notification is the default notifier until VAPID keys and a
 * persisted browser subscription store ship.
 */
export function createWebPushNotifier(): NotifierAdapter {
  return {
    name: "web_push",
    async notify(session, joinUrl) {
      return {
        success: false,
        channel: "web_push",
        joinUrl,
        error: `Web push is post-MVP and not configured for session ${session.id}. Use secure_link.`,
      };
    },
    async test() {
      return {
        ok: false,
        message: "Web push is post-MVP (VAPID + subscription store not implemented)",
      };
    },
  };
}
