import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(
    () => true,
    (socket) => {
      let configured = false;
      socket.onMessage((message) => {
        if (typeof message !== "string") return;
        if (!message) {
          socket.send(
            JSON.stringify({
              tokens: [
                {
                  text: " 마지막 발언",
                  is_final: true,
                  start_ms: 300,
                  end_ms: 1000,
                  speaker: "1",
                },
              ],
              finished: true,
            }),
          );
          return;
        }
        if (!configured) {
          configured = true;
          socket.send(
            JSON.stringify({
              tokens: [
                {
                  text: "회의를 시작합니다.",
                  is_final: true,
                  start_ms: 0,
                  end_ms: 300,
                  speaker: "1",
                },
              ],
            }),
          );
        }
      });
    },
  );
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "아이디", exact: true })
    .fill("owner");
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill("synthetic-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "새 녹음 · 번역" }),
  ).toBeVisible();
});
test("record → final transcript → automatic AI summary → human edit → audio → delete", async ({
  page,
}) => {
  await page.getByLabel("회의 제목", { exact: true }).fill("독립판 통합 시험");
  await page.getByRole("button", { name: "녹음 시작" }).click();
  await expect(
    page.getByText("회의를 시작합니다.", { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "종료 · 저장", exact: true }).click();
  await expect(page.getByLabel("핵심 요약")).toHaveValue("자동 요약 성공", {
    timeout: 15_000,
  });
  await page.getByRole("tab", { name: "원문", exact: true }).click();
  await expect(page.getByText(/회의를 시작합니다.*마지막 발언/)).toBeVisible();
  const audio = page.locator("audio");
  await expect(audio).toBeVisible();
  const response = await page.request.get((await audio.getAttribute("src"))!, {
    headers: { Range: "bytes=0-99" },
  });
  expect(response.status()).toBe(206);
  await page.getByRole("tab", { name: "회의록 · 편집" }).click();
  await page.getByLabel("핵심 요약").fill("사람이 수정한 요약");
  await page.getByRole("button", { name: "회의록 저장" }).click();
  await page.reload();
  await page.getByRole("button", { name: /나의 기록/ }).click();
  await page.getByRole("button", { name: /독립판 통합 시험/ }).click();
  await expect(page.getByLabel("핵심 요약")).toHaveValue("사람이 수정한 요약");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /독립판 통합 시험/ }),
  ).toHaveCount(0);
});
test("discard removes audio and transcript; dialog cancel keeps recording", async ({
  page,
}) => {
  await page.getByLabel("회의 제목", { exact: true }).fill("취소할 기록");
  await page.getByRole("button", { name: "녹음 시작" }).click();
  await expect(
    page.getByText("회의를 시작합니다.", { exact: true }),
  ).toBeVisible();
  page.once("dialog", (d) => d.dismiss());
  await page
    .getByRole("button", { name: "저장하지 않고 종료", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "종료 · 저장", exact: true }),
  ).toBeEnabled();
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "저장하지 않고 종료", exact: true })
    .click();
  await expect(
    page.getByText("음성과 전사를 삭제했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /나의 기록/ }).click();
  await expect(page.getByRole("button", { name: /취소할 기록/ })).toHaveCount(
    0,
  );
});
test("mobile layout and theme keyboard shortcut", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const before = await page.locator("html").getAttribute("data-theme");
  await page.locator("h1").click();
  await page.keyboard.press("d");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", before!);
  await page.getByLabel("회의 제목", { exact: true }).fill("d");
  await page.keyboard.press("d");
  await expect(page.getByLabel("회의 제목", { exact: true })).toHaveValue("dd");
  await page.screenshot({ path: "data/mobile-inspection.png", fullPage: true });
});
