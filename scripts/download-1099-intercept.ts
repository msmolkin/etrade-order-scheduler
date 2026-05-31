/**
 * E*TRADE 1099 PDF downloader via Playwright + Node.js direct POST.
 *
 * How E*TRADE's download works:
 *   1. The Tax Center React app calls the tax.json API to get document metadata,
 *      including a signed documentId (JWT-like token) per segment
 *   2. When the user clicks the download button, the app builds a <form> with
 *      POST method and target="_blank" pointing to https://edoc.etrade.com/e/t/onlinedocs/doc
 *   3. The form fields include: acctNo, amended, docId, docType, load_date, tax_year,
 *      tax_form_type, doc_source
 *
 * Our strategy:
 *   1. Use Playwright to load Tax Center, select year + account
 *   2. Intercept the form.submit() call (via addInitScript hook) to capture params
 *   3. Replay the POST from Node.js using the session cookies, avoiding CORS restriction
 *   4. Save the resulting PDF
 */

import { chromium, type Page, type Response } from "playwright";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { URL } from "url";

const DL = "/home/michael/etrade-trade-placer/data/trade-history/1099-pdfs";
fs.mkdirSync(DL, { recursive: true });

const MARGIN_ACCT_KEY = process.env.ETRADE_MARGIN_ACCT_KEY!;
const MARGIN_ACCT_ID = process.env.ETRADE_MARGIN_ACCT_ID!;

const YEAR_SELECT_INDEX: Record<number, number> = {
  2026: 0,
  2025: 1,
  2024: 2,
  2023: 3,
  2022: 4,
  2021: 5,
  2020: 6,
  2019: 7,
};

const YEARS = [2020, 2021, 2022, 2023];

// Load cookies
const ALL_COOKIES: Array<{ name: string; value: string; domain: string }> =
  JSON.parse(
    fs.readFileSync(
      "/home/michael/etrade-trade-placer/.etrade-cookies.json",
      "utf-8",
    ),
  );

function getCookieHeader(targetDomain: string): string {
  return ALL_COOKIES.filter((c) =>
    targetDomain.endsWith(c.domain.replace(/^\./, "")),
  )
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

function httpPost(
  url: string,
  params: Record<string, string>,
  cookieHeader: string,
  maxRedirects = 5,
): Promise<{
  status: number;
  contentType: string;
  body: Buffer;
  finalUrl: string;
}> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();

    const doPost = (reqUrl: URL, rl: number) => {
      const isHttps = reqUrl.protocol === "https:";
      const lib = isHttps ? https : http;
      const options = {
        hostname: reqUrl.hostname,
        port: reqUrl.port || (isHttps ? 443 : 80),
        path: reqUrl.pathname + reqUrl.search,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          Cookie: cookieHeader,
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36",
          Accept: "application/pdf,text/html,*/*;q=0.8",
          Referer: "https://us.etrade.com/etx/pxy/tax-center",
          Origin: "https://us.etrade.com",
        },
      };

      console.log(`    POST ${reqUrl.href}`);
      const req = lib.request(options, (res) => {
        const status = res.statusCode || 0;
        const contentType = res.headers["content-type"] || "";
        const location = res.headers["location"] || "";
        console.log(
          `    -> ${status} ct=${contentType} loc=${location.slice(0, 80)}`,
        );

        if ([301, 302, 303, 307, 308].includes(status) && location && rl > 0) {
          const nextUrl = new URL(location, reqUrl.href);
          res.resume();
          const getCookies = getCookieHeader(nextUrl.hostname);
          const doGet = (gUrl: URL, grl: number) => {
            const gLib = gUrl.protocol === "https:" ? https : http;
            const gOpts = {
              hostname: gUrl.hostname,
              port: gUrl.port || (gUrl.protocol === "https:" ? 443 : 80),
              path: gUrl.pathname + gUrl.search,
              method: "GET",
              headers: {
                Cookie: getCookies,
                "User-Agent":
                  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36",
                Accept: "application/pdf,*/*",
                Referer: "https://us.etrade.com/etx/pxy/tax-center",
              },
            };
            console.log(`    GET ${gUrl.href}`);
            const gReq = gLib.request(gOpts, (gRes) => {
              const gStatus = gRes.statusCode || 0;
              const gCt = gRes.headers["content-type"] || "";
              const gLoc = gRes.headers["location"] || "";
              console.log(
                `    -> ${gStatus} ct=${gCt} loc=${gLoc.slice(0, 80)}`,
              );
              if (
                [301, 302, 303, 307, 308].includes(gStatus) &&
                gLoc &&
                grl > 0
              ) {
                gRes.resume();
                doGet(new URL(gLoc, gUrl.href), grl - 1);
                return;
              }
              const chunks: Buffer[] = [];
              gRes.on("data", (c) => chunks.push(c));
              gRes.on("end", () =>
                resolve({
                  status: gStatus,
                  contentType: gCt,
                  body: Buffer.concat(chunks),
                  finalUrl: gUrl.href,
                }),
              );
              gRes.on("error", reject);
            });
            gReq.on("error", reject);
            gReq.end();
          };
          doGet(nextUrl, rl - 1);
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status,
            contentType,
            body: Buffer.concat(chunks),
            finalUrl: reqUrl.href,
          }),
        );
        res.on("error", reject);
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    };

    doPost(new URL(url), maxRedirects);
  });
}

async function waitForMarginTaxJson(
  page: Page,
  acctKey: string,
  timeoutMs = 20000,
): Promise<any> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const handler = async (resp: Response) => {
      if (
        resp.url().includes("documents/tax.json") &&
        resp.url().includes(acctKey)
      ) {
        clearTimeout(timer);
        page.off("response", handler);
        try {
          resolve(await resp.json());
        } catch {
          resolve(null);
        }
      }
    };
    page.on("response", handler);
  });
}

async function downloadForYear(
  ctx: any,
  year: number,
): Promise<{ saved: string[]; errors: string[] }> {
  const saved: string[] = [];
  const errors: string[] = [];
  const page: Page = await ctx.newPage();

  try {
    // Intercept form.submit() — don't actually open new tab, just capture params
    await page.addInitScript(() => {
      HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
        const params: Record<string, string> = {};
        for (const el of Array.from(this.elements)) {
          const inp = el as HTMLInputElement;
          if (inp.name) params[inp.name] = inp.value;
        }
        (window as any).__lastFormSubmit = {
          action: this.action,
          method: this.method,
          params,
        };
      };
    });

    const marginTaxJsonPromise = waitForMarginTaxJson(
      page,
      MARGIN_ACCT_KEY,
      30000,
    );

    await page.goto("https://us.etrade.com/etx/pxy/tax-center", {
      timeout: 45000,
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(4000);

    const yearIdx = YEAR_SELECT_INDEX[year];
    console.log(`  Selecting year ${year} (idx ${yearIdx})...`);
    await page
      .locator("select.form-control")
      .first()
      .selectOption({ index: yearIdx });
    await page.waitForTimeout(300);
    console.log(`  Selecting Margin account...`);
    await page
      .locator("select.form-control")
      .nth(1)
      .selectOption({ value: MARGIN_ACCT_ID });

    const taxData = await marginTaxJsonPromise;
    if (!taxData) {
      errors.push(`${year}: no tax.json response`);
      return { saved, errors };
    }

    const docs =
      taxData?.documentListResponse?.documentResponse?.documents?.document;
    const docList = docs ? (Array.isArray(docs) ? docs : [docs]) : [];
    const errCode = taxData?.Error?.code;

    if (errCode) {
      console.log(`  API error: ${errCode}`);
    }
    if (docList.length === 0) {
      console.log(`  No documents for ${year}/Margin`);
      return { saved, errors };
    }

    console.log(`  ${docList.length} document(s) found`);
    await page.waitForTimeout(3000);

    // Click download button — form.submit hook captures params
    await page.evaluate(() => {
      const table = document.querySelector("table.table-rows-stacked");
      if (!table) return;
      for (const btn of Array.from(table.querySelectorAll("tbody button"))) {
        if (!(btn.textContent || "").includes("CSV")) btn.click();
      }
    });
    await page.waitForTimeout(500);

    const formSubmit: any = await page.evaluate(
      () => (window as any).__lastFormSubmit,
    );
    if (!formSubmit) {
      errors.push(`${year}: no form submit captured`);
      return { saved, errors };
    }

    console.log(`  Form action: ${formSubmit.action}`);
    console.log(
      `  Params: tax_year=${formSubmit.params.tax_year} tax_form_type=${formSubmit.params.tax_form_type}`,
    );

    // POST from Node.js (bypasses CORS, uses file-based cookies)
    const targetDomain = new URL(formSubmit.action).hostname;
    const cookieHeader = getCookieHeader(targetDomain);
    console.log(
      `  Cookies for ${targetDomain}: ${cookieHeader.split(";").length} values`,
    );

    const result = await httpPost(
      formSubmit.action,
      formSubmit.params,
      cookieHeader,
    );
    console.log(
      `  HTTP result: ${result.status} ${result.contentType} ${(result.body.length / 1024).toFixed(1)} KB`,
    );

    const isPdf = result.body[0] === 0x25 && result.body[1] === 0x50; // %P
    if (result.contentType.includes("pdf") || isPdf) {
      const subDocType =
        docList[0]?.subDocType?.replace(/[^a-zA-Z0-9]/g, "_") || "1099";
      const fname = `${year}_Margin_${subDocType}.pdf`;
      const fpath = path.join(DL, fname);
      fs.writeFileSync(fpath, result.body);
      console.log(
        `  SAVED: ${fname} (${(result.body.length / 1024).toFixed(1)} KB)`,
      );
      saved.push(fpath);
    } else {
      const preview = result.body
        .toString("utf-8")
        .slice(0, 300)
        .replace(/\n+/g, " ");
      console.log(`  Not a PDF. Preview: ${preview}`);
      errors.push(
        `${year}: got ${result.status} ${result.contentType} — not a PDF`,
      );
    }
  } catch (err: any) {
    console.error(`  ERROR: ${err.message}`);
    errors.push(`${year}: ${err.message}`);
  } finally {
    await page.close();
  }

  return { saved, errors };
}

async function main() {
  console.log(
    "=== E*TRADE 1099 PDF Downloader (Playwright + Node.js POST) ===",
  );
  console.log(`Target: Margin account (key: ${MARGIN_ACCT_KEY})`);
  console.log(`Years: ${YEARS.join(", ")}`);
  console.log(`Output: ${DL}\n`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const cookies = JSON.parse(
    fs.readFileSync(
      "/home/michael/etrade-trade-placer/.etrade-cookies.json",
      "utf-8",
    ),
  );
  await ctx.addCookies(cookies);

  const allSaved: string[] = [];
  const allErrors: string[] = [];

  for (const year of YEARS) {
    console.log(`\n========== Year ${year} ==========`);
    const { saved, errors } = await downloadForYear(ctx, year);
    allSaved.push(...saved);
    allErrors.push(...errors);
  }

  await browser.close();

  console.log(`\n========== Summary ==========`);
  console.log(`PDFs saved: ${allSaved.length}`);
  for (const f of allSaved)
    console.log(
      `  ${path.basename(f)} (${(fs.statSync(f).size / 1024).toFixed(1)} KB)`,
    );
  if (allErrors.length) {
    console.log(`\nErrors:`);
    for (const e of allErrors) console.log(`  ${e}`);
  }

  console.log(`\n=== All PDFs in ${DL} ===`);
  for (const f of fs
    .readdirSync(DL)
    .filter((f) => f.endsWith(".pdf"))
    .sort()) {
    const fpath = path.join(DL, f);
    console.log(`  ${f} (${(fs.statSync(fpath).size / 1024).toFixed(1)} KB)`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
