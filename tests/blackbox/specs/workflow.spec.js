import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Only browser interaction and public HTTP boundaries; no app-module imports.
async function enterWorkspace(page) {
  await page.goto("/ui/");
  await page.locator('[data-action="go-country"]').click();
  await page.locator('[data-action="start"]').click();
  await expect(page.locator('[data-stage="work"]')).toBeVisible();
}

async function chooseTextFolder(page, testInfo) {
  const folder = await mkdtemp(path.join(tmpdir(), "visa-helper-blackbox-"));
  testInfo._fixtureFolder = folder;
  await writeFile(path.join(folder, "example.txt"), "Synthetic visa test material. No real applicant data.");
  await writeFile(path.join(folder, ".DS_Store"), "ignored synthetic metadata");
  await page.locator("#picker").setInputFiles(folder);
  await expect(page.locator("#levelOneBtn")).toBeEnabled();
}

test.beforeEach(async ({ page }) => {
  // Debug logs are unrelated to the assertions and must not clutter the user's log.
  await page.route("**/debug/frontend-log", route => route.fulfill({ status: 204 }));
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo._fixtureFolder) await rm(testInfo._fixtureFolder, { recursive: true, force: true });
});

test("清单成功隐藏重试按钮，未选择材料时锁定后续步骤", async ({ page }) => {
  await enterWorkspace(page);
  await expect(page.locator("#checklist > *").first()).toBeVisible();
  await expect(page.locator("#checklistRetry")).toBeHidden();
  for (const id of ["levelOneBtn", "privacyBtn", "confirmAllBtn", "runBtn"]) {
    await expect(page.locator(`#${id}`)).toBeDisabled();
  }
  const fits = await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight);
  expect(fits).toBe(true);
});

test("清单网络失败自动尝试三次，手动重试成功后隐藏按钮", async ({ page }) => {
  let attempts = 0;
  await page.route("**/material-audit/checklist?*", async route => {
    attempts++;
    if (attempts <= 3) await route.abort("failed");
    else await route.continue();
  });
  await enterWorkspace(page);
  await expect(page.locator("#checklistRetry")).toBeVisible();
  expect(attempts).toBe(3);
  await page.locator("#checklistRetry").click();
  await expect(page.locator("#checklist > *").first()).toBeVisible();
  await expect(page.locator("#checklistRetry")).toBeHidden();
  expect(attempts).toBe(4);
});

test("过滤系统文件，自动预处理，本地审核完成后才解锁脱敏", async ({ page }, testInfo) => {
  const submissions = [];
  page.on("request", request => {
    if (request.url().includes("/material-audit/run")) submissions.push(request);
  });
  await enterWorkspace(page);
  await chooseTextFolder(page, testInfo);
  await expect(page.locator("#filelist")).toContainText("example.txt");
  await expect(page.locator("#filelist")).not.toContainText(".DS_Store");
  await expect(page.locator("#privacyBtn")).toBeDisabled();
  await page.locator("#levelOneBtn").click();
  await expect(page.locator("#levelOneResults")).toContainText("材料内容可读取");
  await expect(page.locator("#privacyBtn")).toBeEnabled();
  await expect(page.locator("#runBtn")).toBeDisabled();
  expect(submissions).toHaveLength(0);
  await page.locator('[data-action="back-country"]').click();
  await expect(page.locator('[data-stage="country"]')).toBeVisible();
  await page.locator('[data-action="start"]').click();
  await expect(page.locator('[data-stage="work"]')).toBeVisible();
  await expect(page.locator("#filelist")).toBeEmpty();
  await expect(page.locator("#levelOneBtn")).toBeDisabled();
});

test("JPG 预处理、隐私页卡保持、拖动预览和撤销、确认后发送新文件", async ({ page }, testInfo) => {
  await enterWorkspace(page);
  const folder = await mkdtemp(path.join(tmpdir(), "visa-helper-blackbox-"));
  testInfo._fixtureFolder = folder;
  // Synthetic image generated in a separate canvas, never from user files.
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 600; canvas.height = 400;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, 600, 400);
    ctx.fillStyle = "black"; ctx.font = "24px sans-serif";
    ctx.fillText("SYNTHETIC TEST DOCUMENT", 30, 45);
    ctx.fillText("Travel itinerary for testing only", 30, 90);
    return canvas.toDataURL("image/jpeg");
  });
  await writeFile(path.join(folder, "synthetic.jpg"), Buffer.from(dataUrl.split(",")[1], "base64"));
  await page.locator("#picker").setInputFiles(folder);
  await expect(page.locator("#levelOneBtn")).toBeEnabled({ timeout: 90_000 });
  await page.locator("#levelOneBtn").click();
  await page.locator("#privacyBtn").click();
  const overlay = page.locator(".redaction-page__overlay").first();
  await expect(overlay).toBeVisible({ timeout: 90_000 });
  await page.locator("#filelist .file-main").first().click();
  await expect(page.locator('[data-tab="privacy"]')).toHaveClass(/tab--active/);
  const box = await overlay.boundingBox();
  const sample = () => overlay.evaluate(canvas => [...canvas.getContext("2d").getImageData(
    Math.round(canvas.width * 0.5), Math.round(canvas.height * 0.6), 1, 1,
  ).data]);
  const before = await sample();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 8 });
  expect(await sample()).toEqual(before); // Selection interior is not black until release.
  const hasOutline = await overlay.evaluate(canvas => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, i) => i % 4 === 2 && value > 50 && pixels[i + 1] > 0);
  });
  expect(hasOutline).toBe(true);
  await page.mouse.up();
  const maskPixel = await sample();
  expect(maskPixel[3]).toBe(255);
  expect(maskPixel.slice(0, 3).every(channel => channel < 16)).toBe(true);
  await page.getByRole("button", { name: "撤销上一笔" }).click();
  expect(await sample()).toEqual(before);
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7);
  await page.mouse.up();
  await page.locator("#confirmAllBtn").click();
  await expect(page.locator("#runBtn")).toBeEnabled();
  const requestPromise = page.waitForRequest("**/material-audit/run");
  await page.locator("#runBtn").click();
  const payload = (await requestPromise).postDataJSON();
  expect(payload.schema_version).toBe("privacy-files/v1");
  expect(payload.privacy.user_reviewed).toBe(true);
  expect(payload.materials[0].sanitized_file.content).toMatch(/^data:image\/jpeg;base64,/);
  expect(payload.materials[0].sanitized_file.content).not.toBe(dataUrl);
  expect(JSON.stringify(payload)).not.toContain("synthetic.jpg");
  const exportedPixel = await page.evaluate(async content => {
    const image = new Image(); image.src = content; await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
    return [...ctx.getImageData(Math.round(image.width * 0.5), Math.round(image.height * 0.6), 1, 1).data];
  }, payload.materials[0].sanitized_file.content);
  expect(exportedPixel[3]).toBe(255);
  expect(exportedPixel.slice(0, 3).every(channel => channel < 16)).toBe(true);
  await expect(page.locator("#runStatus")).toContainText("完成");
});
