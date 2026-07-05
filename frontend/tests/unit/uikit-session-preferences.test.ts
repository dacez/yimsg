import { describe, expect, it, vi } from "vitest";
import { createSessionPreferencesView } from "../../src/uikit/app/views/session-preferences";

function createApp() {
  return {
    client: {
      getBlocklist: vi
        .fn()
        .mockResolvedValue({ offset: 0, total: 1, users: [{ uid: "42" }] }),
      getMutelist: vi
        .fn()
        .mockResolvedValue({ offset: 0, total: 1, mutes: [{ toUid: "42" }] }),
    },
  };
}

describe("session preferences view", () => {
  it("reads blocklist state from backend every time without caching", async () => {
    const app = createApp();
    const view = createSessionPreferencesView(
      app as unknown as Parameters<typeof createSessionPreferencesView>[0],
    );

    await expect(view.isUserBlocked("42")).resolves.toBe(true);
    await expect(view.isUserBlocked("42")).resolves.toBe(true);

    expect(app.client.getBlocklist).toHaveBeenCalledTimes(2);
    expect(app.client.getBlocklist).toHaveBeenNthCalledWith(1, {
      uids: ["42"],
      limit: 1,
    });
    expect(app.client.getBlocklist).toHaveBeenNthCalledWith(2, {
      uids: ["42"],
      limit: 1,
    });
  });

  it("checks mutelist state from backend every time without caching", async () => {
    const app = createApp();
    const view = createSessionPreferencesView(
      app as unknown as Parameters<typeof createSessionPreferencesView>[0],
    );

    await expect(view.isMuted({ toUid: "42" })).resolves.toBe(true);
    await expect(view.isMuted({ toUid: "42" })).resolves.toBe(true);

    expect(app.client.getMutelist).toHaveBeenCalledTimes(2);
    expect(app.client.getMutelist).toHaveBeenNthCalledWith(1, {
      toUid: "42",
      limit: 1,
    });
    expect(app.client.getMutelist).toHaveBeenNthCalledWith(2, {
      toUid: "42",
      limit: 1,
    });
  });
});
