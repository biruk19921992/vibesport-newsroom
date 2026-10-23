const express = require("express");
const path = require("path");
const Parser = require("rss-parser");
const parser = new Parser({ customFields: { item: [["media:thumbnail", "mediaThumbnail"], ["media:content", "mediaContent"]] } });
const fs = require("fs");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Temporary in-memory cache for translations
const translationCache = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/news/sources", (req, res) => {
  try {
    const sources = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "sources.json"), "utf8"));
    res.json({ ok: true, sources });
  } catch (error) {
    res.status(500).json({ ok: false, error: "Could not read news sources" });
  }
});

let newsCache = [];
let newsCacheUpdatedAt = null;
let newsCacheRefreshing = false;

// Safe auto-publishing state. The first successful feed refresh is baseline-only.
let autoPublishBaselineEstablished = false;
const autoPublishedLinks = new Set();


let activeImageLookups = 0;
const imageLookupQueue = [];

async function fetchArticleImage(url) {
  if (!url || !/^https?:\/\//i.test(url)) return "";

  await new Promise(resolve => {
    if (activeImageLookups < 3) {
      activeImageLookups++;
      resolve();
    } else {
      imageLookupQueue.push(resolve);
    }
  });

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 VibeSportNewsroom/1.0" },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return "";

    const html = await response.text();
    const tags = html.match(/<meta\b[^>]*>/gi) || [];

    for (const tag of tags) {
      if (/property=["']og:image["']/i.test(tag) ||
          /name=["']twitter:image["']/i.test(tag)) {
        const match = tag.match(/content=["']([^"']+)["']/i);
        if (match && /^https?:\/\//i.test(match[1])) {
          return match[1].replace(/&amp;/g, "&");
        }
      }
    }
  } catch (error) {
    console.log("Article image lookup skipped:", error.message);
  } finally {
    activeImageLookups--;
    const next = imageLookupQueue.shift();
    if (next) {
      activeImageLookups++;
      next();
    }
  }

  return "";
}

async function publishNewsToWebsite(items) {
  const endpoint = process.env.WEBSITE_WEBHOOK_URL;
  const secret = process.env.NEWS_DESK_WEBHOOK_SECRET;

  if (!endpoint || !secret) {
    console.log("Website publishing skipped: webhook environment variables are missing.");
    return false;
  }

  let allSucceeded = true;

  for (const item of items) {
    if (!item.title || !item.link || !/^https?:\/\//i.test(item.link)) {
      allSucceeded = false;
      continue;
    }

    const externalId = require("crypto")
      .createHash("sha256")
      .update(item.link.trim())
      .digest("hex");

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-newsdesk-secret": secret
        },
        body: JSON.stringify({
          externalId,
          title: item.title,
          description: item.description || "",
          imageUrl: item.imageUrl || "",
          originalUrl: item.link,
          category: item.category || "international"
        }),
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        const errorDetails = (await response.text()).slice(0, 500);
        console.error(
          `Website publish failed (${response.status}) for: ${item.title}. Response: ${errorDetails}`
        );
        allSucceeded = false;
      } else {
        const result = await response.json().catch(() => ({}));
        console.log(
          `Website publish ${result.created ? "created" : result.updated ? "updated" : "accepted"}: ${item.title}`
        );
      }
    } catch (error) {
      console.error("Website publish request failed:", error.message);
      allSucceeded = false;
    }
  }

  return allSucceeded;
}

async function refreshNewsCache() {
  if (newsCacheRefreshing) return;
  newsCacheRefreshing = true;

  try {
    const sources = JSON.parse(
      fs.readFileSync(path.join(__dirname, "data", "sources.json"), "utf8")
    );
    const enabledSources = sources.filter(source => source.enabled);

    const results = await Promise.allSettled(
      enabledSources.map(async source => {
        const feed = await parser.parseURL(source.url);
        return Promise.all((feed.items || []).slice(0, 10).map(async item => {
          let imageUrl =
            item.enclosure?.url ||
            item.itunes?.image ||
            item.image?.url ||
            item.mediaThumbnail?.$?.url ||
            item.mediaContent?.$?.url ||
            item["media:thumbnail"]?.$.url ||
            item["media:content"]?.$.url ||
            "";

          if (!imageUrl && item.link) {
            imageUrl = await fetchArticleImage(item.link);
          }

          return {
            title: item.title || "Untitled",
            imageUrl,
            description: item.contentSnippet || item.summary || item.content || "",
            link: item.link || "",
            publishedAt: item.isoDate || item.pubDate || "",
            source: source.name,
            category: source.category || "international"
          };
        }));
      })
    );

    const successfulFeeds = results.filter(result => result.status === "fulfilled");
    const freshNews = successfulFeeds.flatMap(result => result.value);

    // Do not overwrite a working cache when every feed request fails.
    if (successfulFeeds.length !== enabledSources.length) {
      console.error(
        `News refresh incomplete: ${successfulFeeds.length}/${enabledSources.length} RSS sources succeeded. Auto-publishing paused.`
      );
      return;
    }

    if (successfulFeeds.length === 0) {
      console.error("News refresh failed: all enabled RSS sources failed.");
      return;
    }

    if (freshNews.length > 0 || newsCache.length === 0) {
      newsCache = freshNews;
      newsCacheUpdatedAt = new Date().toISOString();
    }

    const validNews = freshNews.filter(item =>
      item.link && /^https?:\/\//i.test(item.link)
    );

    // First successful refresh only establishes the baseline. Nothing is published.
    if (!autoPublishBaselineEstablished) {
      for (const item of validNews) autoPublishedLinks.add(item.link.trim());
      autoPublishBaselineEstablished = true;
      console.log(
        `Auto-publish baseline established with ${validNews.length} existing links; no articles published on startup.`
      );
    } else {
      const candidates = validNews.filter(item => {
        const link = item.link.trim();
        if (autoPublishedLinks.has(link)) return false;

        // Skip articles with a known publication date older than 36 hours.
        if (item.publishedAt) {
          const publishedTime = Date.parse(item.publishedAt);
          if (Number.isFinite(publishedTime) &&
              Date.now() - publishedTime > 36 * 60 * 60 * 1000) {
            autoPublishedLinks.add(link);
            console.log("Skipping older RSS article:", item.title);
            return false;
          }
        }
        return true;
      }).slice(0, 4);

      for (const item of candidates) {
        try {
          const translated = await translateNews(item.title, item.description);

          if (!translated?.ok ||
              !/[ሀ-ፚ]/.test(String(translated.titleAm || "")) ||
              (item.description && !/[ሀ-ፚ]/.test(String(translated.descriptionAm || "")))) {
            console.error("Auto-publish skipped: incomplete Amharic translation:", item.title);
            continue;
          }

          const published = await publishNewsToWebsite([{
            ...item,
            title: translated.titleAm,
            description: translated.descriptionAm
          }]);

          if (published) {
            autoPublishedLinks.add(item.link.trim());
          } else {
            console.error("Auto-publish will retry next refresh:", item.title);
          }
        } catch (error) {
          console.error("Auto-publish translation failed; will retry:", error.message);
        }
      }
    }

    console.log(
      `News refresh complete: ${newsCache.length} items; ${newsCacheUpdatedAt || "not yet updated"}`
    );
  } catch (error) {
    console.error("News refresh failed:", error.message);
  } finally {
    newsCacheRefreshing = false;
  }
}

app.get("/api/news", async (req, res) => {
  await refreshNewsCache();

  res.json({
    ok: true,
    count: newsCache.length,
    news: newsCache,
    updatedAt: newsCacheUpdatedAt
  });
});


async function translateWithAddisAI(text) {
  if (!text) return "";

  if (!process.env.ADDIS_API_KEY) {
    throw new Error("Addis AI API key is not configured");
  }

  const response = await fetch(
    "https://api.addisassistant.com/api/v1/chat_generate",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ADDIS_API_KEY
      },
      body: JSON.stringify({
        prompt: `Translate this football news into clear, natural Amharic. Keep team and player names accurate. Do not add facts or opinions. Return only the translation:\n\n${text.slice(0, 4500)}`,
        target_language: "am"
      }),
      signal: AbortSignal.timeout(20000)
    }
  );

  if (!response.ok) {
    throw new Error("Addis AI HTTP " + response.status);
  }

  const data = await response.json();
  const translated = String(data.data?.response_text || "").trim();

  if (data.status !== "success" || !translated) {
    throw new Error("Addis AI returned no translation");
  }

  return translated;
}


async function translateNews(title, description) {
  title = String(title || "").trim();
  description = String(description || "").trim();

  if (!title) throw new Error("News title is required");

  const cacheKey = JSON.stringify([title, description]);
  const cached = translationCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, cached: true };
  }
  if (cached) translationCache.delete(cacheKey);

  const isAmharic = value => /[ሀ-ፚ]/.test(String(value || "").trim());

  const validate = (titleAm, descriptionAm, provider) => {
    titleAm = String(titleAm || "").trim();
    descriptionAm = String(descriptionAm || "").trim();

    if (!isAmharic(titleAm)) {
      throw new Error(provider + " did not return an Amharic title");
    }
    if (description && !isAmharic(descriptionAm)) {
      throw new Error(provider + " did not return an Amharic description");
    }

    return {
      ok: true,
      provider,
      titleAm,
      descriptionAm
    };
  };

  const save = result => {
    translationCache.set(cacheKey, {
      result,
      expiresAt: Date.now() + 6 * 60 * 60 * 1000
    });
    return result;
  };

  const errors = [];

  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("Gemini API key is not configured");
    }

    const { GoogleGenAI } = require("@google/genai");
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const prompt = `Translate this football news into clear, natural Amharic.
Keep team and player names accurate. Do not add facts or opinions.
Return valid JSON only with keys "titleAm" and "descriptionAm".
Translate both fields. If the description is empty, return an empty descriptionAm.

Title: ${title}
Description: ${description}`;

    const result = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt
    });

    const cleaned = String(result.text || "")
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");

    const translated = JSON.parse(cleaned);
    return save(validate(translated.titleAm, translated.descriptionAm, "Gemini"));
  } catch (error) {
    errors.push("Gemini: " + error.message);
    console.error("Gemini translation failed:", error.message);
  }

  try {
    const titleAm = await translateWithAddisAI(title);
    const descriptionAm = description
      ? await translateWithAddisAI(description)
      : "";
    return save(validate(titleAm, descriptionAm, "Addis AI"));
  } catch (error) {
    errors.push("Addis AI: " + error.message);
    console.error("Addis AI translation failed:", error.message);
  }

  try {
    async function translateWithMyMemory(text) {
      if (!text) return "";

      const params = new URLSearchParams({
        q: text.slice(0, 4500),
        langpair: "en|am"
      });

      const response = await fetch(
        "https://api.mymemory.translated.net/get?" + params.toString(),
        { signal: AbortSignal.timeout(15000) }
      );

      if (!response.ok) {
        throw new Error("MyMemory HTTP " + response.status);
      }

      const data = await response.json();
      const translated = String(data.responseData?.translatedText || "").trim();

      if (data.responseStatus !== 200 || !translated) {
        throw new Error("MyMemory translation unavailable");
      }

      return translated;
    }

    const titleAm = await translateWithMyMemory(title);
    const descriptionAm = description
      ? await translateWithMyMemory(description)
      : "";
    return save(validate(titleAm, descriptionAm, "MyMemory"));
  } catch (error) {
    errors.push("MyMemory: " + error.message);
    console.error("MyMemory translation failed:", error.message);
  }

  throw new Error("Translation failed: " + errors.join("; "));
}

app.post("/api/news/translate", async (req, res) => {
  const title = String(req.body?.title || "").trim();
  const description = String(req.body?.description || "").trim();

  if (!title) {
    return res.status(400).json({
      ok: false,
      error: "News title is required"
    });
  }

  try {
    return res.json(await translateNews(title, description));
  } catch (error) {
    console.error("All translation providers failed:", error.message);
    return res.status(503).json({
      ok: false,
      error: "ትርጉሙ አልተሳካም። እባክህ በኋላ እንደገና ሞክር።"
    });
  }
});

function requireNewsroomAdmin(req, res, next) {
  const expected = process.env.NEWSROOM_ADMIN_TOKEN;
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  if (!expected) {
    return res.status(503).json({
      ok: false,
      error: "Newsroom admin token is not configured"
    });
  }

  const crypto = require("crypto");
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
}

app.post("/api/news/publish", requireNewsroomAdmin, async (req, res) => {
  const titleAm = String(req.body?.titleAm || "").trim();
  const descriptionAm = String(req.body?.descriptionAm || "").trim();
  const originalTitle = String(req.body?.originalTitle || "").trim();
  const originalDescription = String(req.body?.originalDescription || "").trim();
  const link = String(req.body?.link || "").trim();
  const imageUrl = String(req.body?.imageUrl || "").trim();
  const category = String(req.body?.category || "international").trim();

  if (!titleAm || !link || !/^https?:\/\//i.test(link)) {
    return res.status(400).json({
      ok: false,
      error: "Amharic title and valid original news URL are required"
    });
  }

  if (!/[ሀ-ፚ]/.test(titleAm)) {
    return res.status(400).json({
      ok: false,
      error: "Title must contain Amharic text"
    });
  }

  if (originalDescription && !descriptionAm) {
    return res.status(400).json({
      ok: false,
      error: "Translate the description before publishing"
    });
  }

  const endpoint = process.env.WEBSITE_WEBHOOK_URL;
  const secret = process.env.NEWS_DESK_WEBHOOK_SECRET;

  if (!endpoint || !secret) {
    return res.status(503).json({
      ok: false,
      error: "Website publishing is not configured"
    });
  }

  const externalId = require("crypto")
    .createHash("sha256")
    .update(link)
    .digest("hex");

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-newsdesk-secret": secret
      },
      body: JSON.stringify({
        externalId,
        title: titleAm,
        description: descriptionAm,
        imageUrl: /^https?:\/\//i.test(imageUrl) ? imageUrl : "",
        originalUrl: link,
        category
      }),
      signal: AbortSignal.timeout(15000)
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error("Website publish failed:", response.status, responseText.slice(0, 300));
      return res.status(502).json({
        ok: false,
        error: "VibeSport rejected the publish request",
        websiteStatus: response.status
      });
    }

    console.log("Amharic news published:", titleAm);
    return res.json({ ok: true, message: "News published to VibeSport" });
  } catch (error) {
    console.error("Website publish request failed:", error.message);
    return res.status(502).json({
      ok: false,
      error: "Could not connect to VibeSport"
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "VibeSport AI Newsroom",
    message: "Backend is running"
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

refreshNewsCache();
setInterval(refreshNewsCache, 60 * 60 * 1000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`VibeSport AI Newsroom running on port ${PORT}`);
});
