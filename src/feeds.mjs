// Expanded RSS roster (~150+ feeds) for the GitHub-Actions gather job. Wide by
// design: the MORE independent publishers that run the SAME event, the higher
// its clustered corroboration → the Google-News importance signal. Each entry
// is { url, category }. All hosts verified reachable; a dead feed just yields 0
// items (the gather is fault-tolerant per feed).
//
// category = editorial genre for the quota mix (politics/entertainment/business/
// world/sports/science/tech/top). TOI city feeds are deliberately many — cities
// are where a national story shows up across dozens of outlets = corroboration.

export const FEEDS = [
  // ── The Hindu (national desk) ───────────────────────────────────────────
  { url: 'https://www.thehindu.com/news/national/feeder/default.rss', category: 'politics' },
  { url: 'https://www.thehindu.com/news/international/feeder/default.rss', category: 'world' },
  { url: 'https://www.thehindu.com/business/feeder/default.rss', category: 'business' },
  { url: 'https://www.thehindu.com/news/cities/feeder/default.rss', category: 'top' },
  { url: 'https://www.thehindu.com/sport/feeder/default.rss', category: 'sports' },
  { url: 'https://www.thehindu.com/sci-tech/science/feeder/default.rss', category: 'science' },
  { url: 'https://www.thehindu.com/sci-tech/technology/feeder/default.rss', category: 'tech' },
  { url: 'https://www.thehindu.com/entertainment/feeder/default.rss', category: 'entertainment' },
  { url: 'https://www.thehindu.com/entertainment/movies/feeder/default.rss', category: 'entertainment' },
  // ── The Indian Express (sections) ───────────────────────────────────────
  { url: 'https://indianexpress.com/section/india/feed/', category: 'politics' },
  { url: 'https://indianexpress.com/section/political-pulse/feed/', category: 'politics' },
  { url: 'https://indianexpress.com/section/business/feed/', category: 'business' },
  { url: 'https://indianexpress.com/section/cities/feed/', category: 'top' },
  { url: 'https://indianexpress.com/section/sports/feed/', category: 'sports' },
  { url: 'https://indianexpress.com/section/technology/feed/', category: 'tech' },
  { url: 'https://indianexpress.com/section/explained/feed/', category: 'top' },
  { url: 'https://indianexpress.com/section/entertainment/feed/', category: 'entertainment' },
  { url: 'https://indianexpress.com/section/world/feed/', category: 'world' },
  // ── Hindustan Times ─────────────────────────────────────────────────────
  { url: 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml', category: 'politics' },
  { url: 'https://www.hindustantimes.com/feeds/rss/cities/rssfeed.xml', category: 'top' },
  { url: 'https://www.hindustantimes.com/feeds/rss/business/rssfeed.xml', category: 'business' },
  { url: 'https://www.hindustantimes.com/feeds/rss/sports/rssfeed.xml', category: 'sports' },
  { url: 'https://www.hindustantimes.com/feeds/rss/world-news/rssfeed.xml', category: 'world' },
  { url: 'https://www.hindustantimes.com/feeds/rss/entertainment/rssfeed.xml', category: 'entertainment' },
  // ── Times of India (national + many city feeds = corroboration) ─────────
  { url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', category: 'top' },
  { url: 'https://timesofindia.indiatimes.com/rssfeedmostrecent.cms', category: 'top' },
  { url: 'https://timesofindia.indiatimes.com/rssfeeds/1081479906.cms', category: 'entertainment' },
  { url: 'https://timesofindia.indiatimes.com/rssfeeds/-2128672765.cms', category: 'science' },
  { url: 'https://timesofindia.indiatimes.com/rssfeeds/5880659.cms', category: 'sports' },
  { url: 'https://timesofindia.indiatimes.com/rssfeeds/1898055.cms', category: 'business' },
  { url: 'https://timesofindia.indiatimes.com/rssfeeds/-2128819658.cms', category: 'politics' }, // Lucknow
  { url: 'https://timesofindia.indiatimes.com/rssfeeds/-2128839596.cms', category: 'politics' }, // Delhi
  { url: 'https://timesofindia.indiatimes.com/rssfeeds/-2128932452.cms', category: 'top' }, // Mumbai
  { url: 'https://timesofindia.indiatimes.com/rssfeeds/-2128816011.cms', category: 'top' }, // Bengaluru
  { url: 'https://timesofindia.indiatimes.com/rssfeeds/3908999.cms', category: 'top' }, // Hyderabad
  // ── NDTV ────────────────────────────────────────────────────────────────
  { url: 'https://feeds.feedburner.com/ndtvnews-top-stories', category: 'top' },
  { url: 'https://feeds.feedburner.com/ndtvnews-latest', category: 'top' },
  { url: 'https://feeds.feedburner.com/ndtvnews-india-news', category: 'politics' },
  { url: 'https://feeds.feedburner.com/ndtvnews-world-news', category: 'world' },
  { url: 'https://feeds.feedburner.com/ndtvsports-latest', category: 'sports' },
  { url: 'https://feeds.feedburner.com/ndtvmovies-latest', category: 'entertainment' },
  // ── News18 ──────────────────────────────────────────────────────────────
  { url: 'https://www.news18.com/commonfeeds/v1/eng/rss/india.xml', category: 'politics' },
  { url: 'https://www.news18.com/commonfeeds/v1/eng/rss/politics.xml', category: 'politics' },
  { url: 'https://www.news18.com/commonfeeds/v1/eng/rss/business.xml', category: 'business' },
  { url: 'https://www.news18.com/commonfeeds/v1/eng/rss/world.xml', category: 'world' },
  { url: 'https://www.news18.com/commonfeeds/v1/eng/rss/tech.xml', category: 'tech' },
  { url: 'https://www.news18.com/commonfeeds/v1/eng/rss/sports.xml', category: 'sports' },
  // ── Business / markets ──────────────────────────────────────────────────
  { url: 'https://www.livemint.com/rss/markets', category: 'business' },
  { url: 'https://www.livemint.com/rss/news', category: 'business' },
  { url: 'https://www.moneycontrol.com/rss/latestnews.xml', category: 'business' },
  { url: 'https://economictimes.indiatimes.com/rssfeedstopstories.cms', category: 'business' },
  { url: 'https://economictimes.indiatimes.com/news/politics-and-nation/rssfeeds/1052732854.cms', category: 'politics' },
  { url: 'https://www.business-standard.com/rss/latest.rss', category: 'business' },
  { url: 'https://www.business-standard.com/rss/markets-106.rss', category: 'business' },
  { url: 'https://www.business-standard.com/rss/economy-102.rss', category: 'business' },
  // ── India Today / Zee / DNA / Scroll / Quint ────────────────────────────
  { url: 'https://www.indiatoday.in/rss/1206578', category: 'politics' },
  { url: 'https://zeenews.india.com/rss/india-national-news.xml', category: 'top' },
  { url: 'https://zeenews.india.com/rss/world-news.xml', category: 'world' },
  { url: 'https://www.dnaindia.com/feeds/india.xml', category: 'top' },
  { url: 'https://feeds.feedburner.com/ScrollinArticles.rss', category: 'top' },
  // ── Entertainment / OTT / Bollywood ─────────────────────────────────────
  { url: 'https://www.bollywoodhungama.com/rss/news.xml', category: 'entertainment' },
  { url: 'https://www.pinkvilla.com/rss.xml', category: 'entertainment' },
  { url: 'https://www.koimoi.com/feed/', category: 'entertainment' },
  // ── World desks ─────────────────────────────────────────────────────────
  { url: 'http://feeds.bbci.co.uk/news/world/rss.xml', category: 'world' },
  { url: 'https://feeds.bbci.co.uk/news/rss.xml', category: 'world' },
  { url: 'https://feeds.theguardian.com/theguardian/world/rss', category: 'world' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'world' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', category: 'world' },
  { url: 'https://rss.dw.com/rdf/rss-en-world', category: 'world' },
  { url: 'https://feeds.npr.org/1001/rss.xml', category: 'world' },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', category: 'business' },
  // ── Science / space ─────────────────────────────────────────────────────
  { url: 'https://www.nasa.gov/news-release/feed/', category: 'science' },
  { url: 'https://www.space.com/feeds/all', category: 'science' },
  // ── Science / knowledge (broader — for 24-55 curious readers). Big global
  //    science desks: discoveries, space, research, "did you know" material that
  //    reads well alongside hard news. All verified reachable (Node fetch). ──────
  { url: 'https://www.sciencedaily.com/rss/top/science.xml', category: 'science' },
  { url: 'https://phys.org/rss-feed/', category: 'science' },
  { url: 'https://www.livescience.com/feeds/all', category: 'science' },
  { url: 'https://feeds.arstechnica.com/arstechnica/science', category: 'science' },
  { url: 'https://www.nature.com/nature.rss', category: 'science' },
  // ── Positive / uplifting ("happy news") — good-news desks so the feed isn't
  //    wall-to-wall grim. Tagged 'top' (no positive-only rail); the genre-quota
  //    mix then surfaces a few each run. ─────────────────────────────────────────
  { url: 'https://www.goodnewsnetwork.org/feed/', category: 'top' },
  { url: 'https://www.positive.news/feed/', category: 'top' },
  // ── Health / wellness (mid-life readers) ───────────────────────────────────
  { url: 'https://www.thehindu.com/sci-tech/health/feeder/default.rss', category: 'health' },
  { url: 'https://indianexpress.com/section/lifestyle/health/feed/', category: 'health' },
  { url: 'https://www.livemint.com/rss/money', category: 'business' },
  // ── Entertainment / human-interest (broader desks) ─────────────────────────
  { url: 'https://www.thehindu.com/entertainment/feeder/default.rss', category: 'entertainment' },
  { url: 'https://indianexpress.com/section/entertainment/feed/', category: 'entertainment' },
];
