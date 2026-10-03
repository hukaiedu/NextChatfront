import { jest } from "@jest/globals";
import { getVersion, useUpdateStore } from "../app/store/update";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});
function reply(data: unknown, ok = true) {
  global.fetch = jest
    .fn<typeof fetch>()
    .mockResolvedValue({ ok, json: async () => data } as Response);
}
test("accepts valid tag and commit date responses", async () => {
  reply([{ name: "v2.0.0" }]);
  expect(await getVersion("tag")).toBe("v2.0.0");
  reply([{ commit: { author: { date: "2026-10-03T00:00:00Z" } } }]);
  expect(await getVersion("date")).toBe(
    String(Date.parse("2026-10-03T00:00:00Z")),
  );
});
test.each([{ message: "API error" }, [], [{}], [{ name: 123 }]])(
  "rejects malformed tags %j",
  async (data) => {
    reply(data);
    await expect(getVersion("tag")).rejects.toThrow();
  },
);
test("rejects HTTP failures and invalid dates", async () => {
  reply([{ name: "v2.0.0" }], false);
  await expect(getVersion("tag")).rejects.toThrow(
    "Version service unavailable",
  );
  reply([{ commit: { author: { date: "invalid" } } }]);
  await expect(getVersion("date")).rejects.toThrow("Invalid version date");
});
test("marks failures explicitly and recovers on retry", async () => {
  useUpdateStore.setState({
    remoteVersion: "stale",
    versionType: "tag",
    lastUpdate: 0,
  });
  reply({ message: "API error" });
  await useUpdateStore.getState().getLatestVersion(true);
  expect(useUpdateStore.getState()).toMatchObject({
    remoteVersion: "",
    updateError: true,
    lastUpdate: 0,
  });
  reply([{ name: "v2.0.0" }]);
  await useUpdateStore.getState().getLatestVersion(true);
  expect(useUpdateStore.getState()).toMatchObject({
    remoteVersion: "v2.0.0",
    updateError: false,
  });
});
