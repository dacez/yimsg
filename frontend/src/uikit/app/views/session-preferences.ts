import type { ConversationTarget } from "../../../sdk";
import type { AppInstance } from "../app-instance";

function toConversationTarget(
  target: ConversationTarget | { toUid?: string; groupId?: string },
): ConversationTarget {
  const groupId = String(target.groupId || "0");
  if (groupId !== "0") return { groupId };
  return { toUid: String(target.toUid || "0") };
}

export function createSessionPreferencesView(app: AppInstance) {
  return {
    async isUserBlocked(uid: string): Promise<boolean> {
      if (!uid || uid === "0") return false;
      const page = await app.client.getBlocklist({ uids: [uid], limit: 1 });
      return page.users.length > 0;
    },
    async isMuted(
      target: ConversationTarget | { toUid?: string; groupId?: string },
    ): Promise<boolean> {
      const normalized = toConversationTarget(target);
      const page =
        "groupId" in normalized
          ? await app.client.getMutelist({
              groupId: normalized.groupId,
              limit: 1,
            })
          : await app.client.getMutelist({ toUid: normalized.toUid, limit: 1 });
      return page.mutes.length > 0;
    },
  };
}
