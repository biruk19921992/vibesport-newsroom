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
    return;
  }

  for (const item of items) {
    if (!item.title || !item.link || !/^https?:\/\//i.test(item.link)) continue;

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
        console.error(`Website publish failed (${response.status}) for: ${item.title}`);
      } else {
        const result = await response.json().catch(() => ({}));
        console.log(`Website publish ${result.created ? "created" : result.updated ? "updated" : "accepted"}: ${item.title}`);
      }
    } catch (error) {
      console.error("Website publish request failed:", error.message);
    }
  }
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

    const freshNews = results.flatMap(result =>
      result.status === "fulfilled" ? result.value : []
    );

    if (freshNews.length > 0 || newsCache.length === 0) {
      newsCache = freshNews;
      newsCacheUpdatedAt = new Date().toISOString();
      await publishNewsToWebsite(freshNews);
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

app.post("/api/news/translate", async (req, res) => {
  const title = String(req.body?.title || "").trim();
  const description = String(req.body?.description || "").trim();

  if (!title) {
    return res.status(400).json({ ok: false, error: "News title is required" });
  }

  const cacheKey = JSON.stringify([title, description]);
  const cached = translationCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ ...cached.result, cached: true });
  }

  if (cached) translationCache.delete(cacheKey);

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

  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("Gemini API key is not configured");
    }

    const { GoogleGenAI } = require("@google/genai");
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const prompt = `Translate this football news into clear, natural Amharic.
Keep team and player names accurate. Do not add facts or opinions.
Return JSON only with keys "titleAm" and "descriptionAm".

Title: ${title}
Description: ${description}`;

    const result = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt
    });

    const text = result.text || "";
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const translated = JSON.parse(cleaned);

    if (!translated.titleAm) {
      throw new Error("Gemini returned an empty translation");
    }

    const resultData = {
      ok: true,
      provider: "Gemini",
      titleAm: String(translated.titleAm),
      descriptionAm: String(translated.descriptionAm || "")
    };
    translationCache.set(cacheKey, {
      result: resultData,
      expiresAt: Date.now() + 6 * 60 * 60 * 1000
    });
    return res.json(resultData);
  } catch (geminiError) {
    console.error("Gemini translation failed; trying Addis AI:", geminiError.message);
  }

  try {
    const titleAm = await translateWithAddisAI(title);
    let descriptionAm = "";
    if (description) {
      try {
        descriptionAm = await translateWithAddisAI(description);
      } catch (error) {
        console.error("Addis AI description translation failed:", error.message);
      }
    }

    const resultData = {
      ok: true,
      provider: "Addis AI",
      titleAm,
      descriptionAm
    };
    translationCache.set(cacheKey, {
      result: resultData,
      expiresAt: Date.now() + 6 * 60 * 60 * 1000
    });
    return res.json(resultData);
  } catch (addisError) {
    console.error("Addis AI translation failed; trying MyMemory:", addisError.message);
  }
try {
    const titleAm = await translateWithMyMemory(title);
    let descriptionAm = "";

    if (description) {
      try {
        descriptionAm = await translateWithMyMemory(description);
      } catch (error) {
        console.error("MyMemory description translation failed:", error.message);
      }
    }

    const resultData = {
      ok: true,
      provider: "MyMemory",
      titleAm,
      descriptionAm
    };
    translationCache.set(cacheKey, {
      result: resultData,
      expiresAt: Date.now() + 6 * 60 * 60 * 1000
    });
    return res.json(resultData);
  } catch (error) {
    console.error("All translation providers failed:", error.message);
    return res.status(503).json({
      ok: false,
      error: "ትርጉሙ አልተሳካም። እባክህ በኋላ እንደገና ሞክር።"
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
