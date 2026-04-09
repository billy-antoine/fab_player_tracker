import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { load } from 'cheerio'
import express from 'express'

type CoverageRound = {
  label: string
  number: number
  pairingsUrl: string | null
  resultsUrl: string | null
  standingsUrl: string | null
  standingsPublished: boolean
}

type RoundScore = {
  dropped: boolean
  rank: string | null
  wins: number | null
}

type ImportedPlayer = {
  heroImageUrl: string | null
  heroName: string | null
  id: string
  name: string
  rounds: Record<string, RoundScore>
}

type ImportedTournament = {
  defaultRound: number | null
  eventName: string
  eventUrl: string
  importedAt: string
  players: ImportedPlayer[]
  rounds: CoverageRound[]
}

type PairingsPlayer = {
  heroImageUrl: string | null
  heroName: string | null
  name: string
}

type StandingsEntry = {
  dropped: boolean
  heroName: string | null
  name: string
  rank: string | null
  wins: number | null
}

type PlayerAggregate = {
  heroImageUrl: string | null
  heroName: string | null
  id: string
  key: string
  name: string
  rounds: Record<string, RoundScore>
}

const app = express()
const port = Number.parseInt(process.env.PORT ?? '8787', 10)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')

const coverageCache = new Map<string, { data: ImportedTournament; expiresAt: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000

const REQUEST_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9,fr-FR;q=0.8,fr;q=0.7',
  'cache-control': 'no-cache',
  'pragma': 'no-cache',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
} as const

app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/import', async (req, res) => {
  const inputUrl = typeof req.body?.url === 'string' ? req.body.url : ''

  if (!inputUrl.trim()) {
    res.status(400).json({ error: "Le lien de l'evenement est requis." })
    return
  }

  try {
    const tournament = await importTournament(inputUrl)
    res.json(tournament)
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Impossible d'importer les donnees de l'evenement."

    res.status(500).json({ error: message })
  }
})

app.get('/api/hero-image', async (req, res) => {
  const src = typeof req.query.src === 'string' ? req.query.src : ''

  if (!src) {
    res.status(400).send('Missing src query parameter.')
    return
  }

  try {
    const imageUrl = new URL(src)

    if (!isAllowedRemoteHost(imageUrl)) {
      res.status(400).send('Unsupported image host.')
      return
    }

    const response = await fetch(imageUrl, {
      headers: {
        'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'referer': 'https://fabtcg.com/',
        'user-agent': REQUEST_HEADERS['user-agent'],
      },
      redirect: 'follow',
    })

    if (!response.ok) {
      throw new Error(`Image fetch failed with status ${response.status}.`)
    }

    const contentType = response.headers.get('content-type') ?? 'image/jpeg'
    const imageBuffer = Buffer.from(await response.arrayBuffer())

    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.send(imageBuffer)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to proxy hero image.'

    res.status(502).send(message)
  }
})

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))

  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

app.listen(port, () => {
  console.log(`FAB tracker API listening on http://localhost:${port}`)
})

async function importTournament(rawUrl: string): Promise<ImportedTournament> {
  const eventUrl = normalizeCoverageUrl(rawUrl)
  const cached = coverageCache.get(eventUrl)

  if (cached && cached.expiresAt > Date.now()) {
    return cached.data
  }

  const mainHtml = await fetchHtml(eventUrl)
  const { eventName, rounds } = parseCoveragePage(mainHtml, eventUrl)

  if (!rounds.length) {
    throw new Error(
      "Aucune ronde n'a ete detectee sur cette page de coverage. Verifie que le lien pointe vers une page FabTCG de type /coverage/..."
    )
  }

  const pairingsPages = await mapWithConcurrency(
    rounds.filter((round) => round.pairingsUrl),
    4,
    async (round) => {
      try {
        const html = await fetchHtml(round.pairingsUrl!)
        return { players: parsePairingsPage(html), roundNumber: round.number }
      } catch (error) {
        console.warn(`Unable to fetch pairings for round ${round.number}`, error)
        return null
      }
    }
  )

  const standingsPages = await mapWithConcurrency(
    rounds.filter((round) => round.standingsPublished && round.standingsUrl),
    4,
    async (round) => {
      try {
        const html = await fetchHtml(round.standingsUrl!)
        return {
          entries: parseStandingsPage(html),
          roundNumber: round.number,
        }
      } catch (error) {
        console.warn(`Unable to fetch standings for round ${round.number}`, error)
        return null
      }
    }
  )

  const playersByKey = new Map<string, PlayerAggregate>()

  for (const parsedPage of pairingsPages) {
    if (!parsedPage) {
      continue
    }

    for (const player of parsedPage.players) {
      const aggregate = upsertPlayer(playersByKey, player.name)
      aggregate.heroImageUrl ??= player.heroImageUrl
      aggregate.heroName ??= player.heroName
    }
  }

  for (const parsedPage of standingsPages) {
    if (!parsedPage) {
      continue
    }

    for (const entry of parsedPage.entries) {
      const aggregate = upsertPlayer(playersByKey, entry.name)
      aggregate.heroName ??= entry.heroName
      aggregate.rounds[String(parsedPage.roundNumber)] = {
        dropped: entry.dropped,
        rank: entry.rank,
        wins: entry.wins,
      }
    }
  }

  const players = [...playersByKey.values()]
    .map<ImportedPlayer>((player) => ({
      heroImageUrl: player.heroImageUrl,
      heroName: player.heroName,
      id: player.id,
      name: player.name,
      rounds: player.rounds,
    }))
    .sort((left, right) =>
      left.name.localeCompare(right.name, 'fr', { sensitivity: 'base' })
    )

  const defaultRound =
    rounds
      .filter((round) => round.standingsPublished)
      .map((round) => round.number)
      .sort((left, right) => right - left)[0] ?? null

  const importedTournament: ImportedTournament = {
    defaultRound,
    eventName,
    eventUrl,
    importedAt: new Date().toISOString(),
    players,
    rounds,
  }

  coverageCache.set(eventUrl, {
    data: importedTournament,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })

  return importedTournament
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: REQUEST_HEADERS,
    redirect: 'follow',
  })

  if (!response.ok) {
    throw new Error(`Request failed for ${url} with status ${response.status}.`)
  }

  const html = await response.text()

  if (!html.trim()) {
    throw new Error(`Empty response body received from ${url}.`)
  }

  return html
}

function parseCoveragePage(
  html: string,
  pageUrl: string
): { eventName: string; rounds: CoverageRound[] } {
  const $ = load(html)

  const eventName =
    normalizeWhitespace(
      $('article.coverage h1, article.coverage .entry-title, main h1')
        .first()
        .text()
    ) || slugToTitle(new URL(pageUrl).pathname)

  const rounds = $('section.coverage-main tbody tr')
    .toArray()
    .map((row): CoverageRound | null => {
      const label = normalizeWhitespace($(row).find('td.rounds').text())
      const roundMatch = label.match(/Round\s+(\d+)/i)

      if (!label || !roundMatch) {
        return null
      }

      const number = Number.parseInt(roundMatch[1], 10)

      return {
        label,
        number,
        pairingsUrl: toAbsoluteUrl($(row).find('td.pairings a').attr('href'), pageUrl),
        resultsUrl: toAbsoluteUrl($(row).find('td.results-cell a').attr('href'), pageUrl),
        standingsPublished: Boolean($(row).find('td.standings-cell a').attr('href')),
        standingsUrl: toAbsoluteUrl(
          $(row).find('td.standings-cell a').attr('href'),
          pageUrl
        ),
      }
    })
    .filter((round): round is CoverageRound => round !== null)
    .sort((left, right) => left.number - right.number)

  return { eventName, rounds }
}

function parsePairingsPage(html: string): PairingsPlayer[] {
  const $ = load(html)
  const players: PairingsPlayer[] = []

  $('table.pairings-table tbody tr.match-row').each((_, row) => {
    for (const selector of ['td.player-1-cell', 'td.player-2-cell']) {
      const parsedPlayer = parsePairingsCell($, $(row).find(selector).first())

      if (parsedPlayer) {
        players.push(parsedPlayer)
      }
    }
  })

  return players
}

function parsePairingsCell(
  $: ReturnType<typeof load>,
  cell: ReturnType<ReturnType<typeof load>>
): PairingsPlayer | null {
  if (!cell.length) {
    return null
  }

  const playerText = cell.find('.player-text').first()
  const heroName =
    normalizeWhitespace(playerText.find('.hero-name').text()) ||
    normalizeWhitespace(cell.find('img.hero-img').attr('alt') ?? '') ||
    null

  const name = extractDirectText($, playerText)

  if (!name || /^bye$/i.test(name)) {
    return null
  }

  return {
    heroImageUrl: proxiedHeroUrl(cell.find('img.hero-img').attr('src')),
    heroName,
    name,
  }
}

function parseStandingsPage(html: string): StandingsEntry[] {
  const $ = load(html)

  return $('section.coverage-main tbody tr')
    .toArray()
    .map((row): StandingsEntry | null => {
      const name = normalizeWhitespace($(row).find('.player-name').text())

      if (!name) {
        return null
      }

      const rank = normalizeWhitespace($(row).find('td.rank').text()) || null
      const winsText = normalizeWhitespace($(row).find('td.wins').text())
      const wins = winsText ? Number.parseInt(winsText, 10) : null

      return {
        dropped: /dropped/i.test(rank ?? ''),
        heroName: normalizeWhitespace($(row).find('.hero-name').text()) || null,
        name,
        rank,
        wins: Number.isNaN(wins) ? null : wins,
      }
    })
    .filter((entry): entry is StandingsEntry => entry !== null)
}

function upsertPlayer(
  playersByKey: Map<string, PlayerAggregate>,
  name: string
): PlayerAggregate {
  const key = normalizePlayerKey(name)
  const existing = playersByKey.get(key)

  if (existing) {
    return existing
  }

  const created: PlayerAggregate = {
    heroImageUrl: null,
    heroName: null,
    id: key,
    key,
    name,
    rounds: {},
  }

  playersByKey.set(key, created)
  return created
}

function proxiedHeroUrl(src: string | undefined): string | null {
  if (!src) {
    return null
  }

  return `/api/hero-image?src=${encodeURIComponent(src)}`
}

function toAbsoluteUrl(href: string | undefined, baseUrl: string): string | null {
  if (!href) {
    return null
  }

  try {
    return new URL(href, baseUrl).toString()
  } catch {
    return null
  }
}

function extractDirectText(
  $: ReturnType<typeof load>,
  element: ReturnType<ReturnType<typeof load>>
): string {
  const directText = element
    .contents()
    .toArray()
    .filter((node) => node.type === 'text')
    .map((node) => $(node).text())
    .join(' ')

  return normalizeWhitespace(directText)
}

function normalizeCoverageUrl(rawUrl: string): string {
  let url: URL

  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Le lien saisi est invalide.')
  }

  if (!/^https?:$/.test(url.protocol)) {
    throw new Error('Le lien doit commencer par http:// ou https://')
  }

  if (!url.hostname.endsWith('fabtcg.com')) {
    throw new Error('Le parser actuel supporte uniquement les pages fabtcg.com.')
  }

  if (!url.pathname.includes('/coverage/')) {
    throw new Error(
      "Le lien doit pointer vers une page de coverage FabTCG, par exemple /coverage/calling-toulouse/."
    )
  }

  url.hash = ''
  url.search = ''

  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`
  }

  return url.toString()
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizePlayerKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
}

function slugToTitle(pathname: string): string {
  const slug = pathname
    .split('/')
    .filter(Boolean)
    .at(-1)

  if (!slug) {
    return 'FAB Coverage'
  }

  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function isAllowedRemoteHost(url: URL): boolean {
  return (
    url.hostname.endsWith('fabtcg.com') ||
    url.hostname.endsWith('cloudfront.net') ||
    url.hostname.endsWith('fabtcg.net')
  )
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex
        nextIndex += 1
        results[currentIndex] = await worker(items[currentIndex])
      }
    }
  )

  await Promise.all(runners)
  return results
}
