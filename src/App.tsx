import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { toPng } from 'html-to-image'

import './App.css'
import type { ImportedPlayer, ImportedTournament, RoundScore } from './types'

const DEFAULT_EVENT_URL = 'https://fabtcg.com/coverage/calling-toulouse/'
const SETTINGS_KEY = 'fab-player-tracker-settings-v1'

type SortMode = 'selection' | 'score'

type PersistedSettings = {
  customTitle: string
  eventUrl: string
  selectedPlayerIds: string[]
  selectedRound: number | null
  sortMode: SortMode
}

type DisplayPlayer = {
  cumulativeRecord: CumulativeRecord
  player: ImportedPlayer
  record: RoundScore | null
  selectionIndex: number
}

type CumulativeRecord = {
  draws: number
  losses: number
  wins: number
}

function App() {
  const initialSettings = useMemo(loadSettings, [])
  const [eventUrl, setEventUrl] = useState(
    initialSettings.eventUrl || DEFAULT_EVENT_URL
  )
  const [customTitle, setCustomTitle] = useState(initialSettings.customTitle)
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<string[]>(
    initialSettings.selectedPlayerIds
  )
  const [selectedRound, setSelectedRound] = useState<number | null>(
    initialSettings.selectedRound
  )
  const [sortMode, setSortMode] = useState<SortMode>(initialSettings.sortMode)
  const [searchTerm, setSearchTerm] = useState('')
  const [importedData, setImportedData] = useState<ImportedTournament | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  const overlayRef = useRef<HTMLDivElement | null>(null)
  const deferredSearch = useDeferredValue(searchTerm)

  const publishedRounds = useMemo(
    () =>
      importedData?.rounds
        .filter((round) => round.standingsPublished)
        .sort((left, right) => left.number - right.number) ?? [],
    [importedData]
  )

  const activeRoundNumber = selectedRound ?? publishedRounds.at(-1)?.number ?? null
  const activeRound = useMemo(
    () => publishedRounds.find((round) => round.number === activeRoundNumber) ?? null,
    [activeRoundNumber, publishedRounds]
  )

  const playerMap = useMemo(
    () => new Map(importedData?.players.map((player) => [player.id, player]) ?? []),
    [importedData]
  )

  const selectedPlayers = useMemo(
    () =>
      selectedPlayerIds
        .map((playerId) => playerMap.get(playerId) ?? null)
        .filter((player): player is ImportedPlayer => player !== null),
    [playerMap, selectedPlayerIds]
  )

  const selectedPlayerSet = useMemo(
    () => new Set(selectedPlayerIds),
    [selectedPlayerIds]
  )

  const suggestions = useMemo(() => {
    if (!importedData) {
      return []
    }

    const normalizedQuery = normalizeSearchValue(deferredSearch)

    if (!normalizedQuery) {
      return []
    }

    return importedData.players
      .filter((player) => !selectedPlayerSet.has(player.id))
      .filter((player) => {
        const haystack = [
          normalizeSearchValue(player.name),
          normalizeSearchValue(player.heroName ?? ''),
        ]

        return haystack.some((value) => value.includes(normalizedQuery))
      })
      .slice(0, 8)
  }, [deferredSearch, importedData, selectedPlayerSet])

  const displayPlayers = useMemo<DisplayPlayer[]>(() => {
    const players = selectedPlayers.map((player, selectionIndex) => ({
      cumulativeRecord: summarizeRounds(player, activeRoundNumber),
      player,
      record: activeRoundNumber ? player.rounds[String(activeRoundNumber)] ?? null : null,
      selectionIndex,
    }))

    if (sortMode === 'selection') {
      return players
    }

    return [...players].sort((left, right) => {
      const leftDropped = left.record?.dropped ?? false
      const rightDropped = right.record?.dropped ?? false

      if (leftDropped !== rightDropped) {
        return leftDropped ? 1 : -1
      }

      const leftWins = left.cumulativeRecord.wins
      const rightWins = right.cumulativeRecord.wins

      if (leftWins !== rightWins) {
        return rightWins - leftWins
      }

      const leftDraws = left.cumulativeRecord.draws
      const rightDraws = right.cumulativeRecord.draws

      if (leftDraws !== rightDraws) {
        return rightDraws - leftDraws
      }

      const leftLosses = left.cumulativeRecord.losses
      const rightLosses = right.cumulativeRecord.losses

      if (leftLosses !== rightLosses) {
        return leftLosses - rightLosses
      }

      return left.selectionIndex - right.selectionIndex
    })
  }, [activeRoundNumber, selectedPlayers, sortMode])

  const overlayTitle =
    customTitle.trim() ||
    buildDefaultTitle(importedData?.eventName ?? null, activeRound?.label ?? null)

  useEffect(() => {
    if (!importedData) {
      return
    }

    const validIds = new Set(importedData.players.map((player) => player.id))
    setSelectedPlayerIds((current) => current.filter((playerId) => validIds.has(playerId)))
  }, [importedData])

  useEffect(() => {
    const roundStillAvailable = publishedRounds.some(
      (round) => round.number === selectedRound
    )

    if (!roundStillAvailable) {
      setSelectedRound(publishedRounds.at(-1)?.number ?? null)
    }
  }, [publishedRounds, selectedRound])

  useEffect(() => {
    saveSettings({
      customTitle,
      eventUrl,
      selectedPlayerIds,
      selectedRound: activeRoundNumber,
      sortMode,
    })
  }, [activeRoundNumber, customTitle, eventUrl, selectedPlayerIds, sortMode])

  async function handleImport() {
    setIsImporting(true)
    setErrorMessage('')
    setStatusMessage("Import des donnees en cours...")

    try {
      const response = await fetch('/api/import', {
        body: JSON.stringify({ url: eventUrl }),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })

      const payload = (await response.json()) as ImportedTournament | { error: string }

      if (!response.ok || 'error' in payload) {
        throw new Error('error' in payload ? payload.error : "L'import a echoue.")
      }

      startTransition(() => {
        setImportedData(payload)
        setSelectedRound((currentRound) => {
          const roundExists = payload.rounds.some(
            (round) => round.standingsPublished && round.number === currentRound
          )

          return roundExists ? currentRound : payload.defaultRound
        })
        setSelectedPlayerIds((currentPlayers) =>
          currentPlayers.filter((playerId) =>
            payload.players.some((player) => player.id === playerId)
          )
        )
      })

      setStatusMessage(
        `${payload.players.length} joueurs importes, ${payload.rounds.length} rondes detectees.`
      )
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Impossible d'importer l'evenement."
      )
      setStatusMessage('')
    } finally {
      setIsImporting(false)
    }
  }

  function addPlayer(player: ImportedPlayer) {
    setSelectedPlayerIds((current) =>
      current.includes(player.id) ? current : [...current, player.id]
    )
    setSearchTerm('')
  }

  function removePlayer(playerId: string) {
    setSelectedPlayerIds((current) =>
      current.filter((currentId) => currentId !== playerId)
    )
  }

  async function handleExport() {
    if (!overlayRef.current || !displayPlayers.length) {
      return
    }

    setIsExporting(true)
    setErrorMessage('')

    try {
      await document.fonts.ready
      await Promise.all(
        [...overlayRef.current.querySelectorAll('img')].map(async (image) => {
          try {
            await image.decode()
          } catch {
            return undefined
          }
        })
      )

      const png = await toPng(overlayRef.current, {
        backgroundColor: 'transparent',
        cacheBust: true,
        pixelRatio: 2.5,
      })

      const link = document.createElement('a')
      link.href = png
      link.download = buildFileName(
        importedData?.eventName ?? 'fab-player-tracker',
        activeRound?.label ?? 'overlay'
      )
      link.click()
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "L'export PNG a echoue."
      )
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="hero-banner">
        <div>
          <p className="eyebrow">Flesh and Blood Tracker</p>
          <h1>Importer un event FabTCG et produire un overlay OBS transparent</h1>
          <p className="hero-copy">
            Colle un lien de coverage, choisis les joueurs a suivre, selectionne
            la ronde publiee et exporte la liste en PNG transparent.
          </p>
        </div>
        <div className="hero-card">
          <span>Flux cible</span>
          <strong>OBS Ready</strong>
          <small>PNG transparent + preview live</small>
        </div>
      </header>

      <main className="workspace">
        <section className="control-column">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Source</p>
                <h2>Evenement</h2>
              </div>
            </div>

            <label className="field">
              <span>Lien de coverage</span>
              <input
                type="url"
                value={eventUrl}
                onChange={(event) => setEventUrl(event.target.value)}
                placeholder={DEFAULT_EVENT_URL}
              />
            </label>

            <div className="button-row">
              <button
                className="primary-button"
                onClick={() => void handleImport()}
                disabled={isImporting}
              >
                {isImporting ? 'Import en cours...' : "Charger l'evenement"}
              </button>
            </div>

            {statusMessage ? <p className="notice success">{statusMessage}</p> : null}
            {errorMessage ? <p className="notice error">{errorMessage}</p> : null}

            {importedData ? (
              <div className="stats-grid">
                <div className="stat-card">
                  <span>Event</span>
                  <strong>{importedData.eventName}</strong>
                </div>
                <div className="stat-card">
                  <span>Joueurs</span>
                  <strong>{importedData.players.length}</strong>
                </div>
                <div className="stat-card">
                  <span>Rondes</span>
                  <strong>{publishedRounds.length}</strong>
                </div>
              </div>
            ) : null}
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Selection</p>
                <h2>Joueurs a tracker</h2>
              </div>
              {selectedPlayerIds.length ? (
                <button
                  className="text-button"
                  onClick={() => setSelectedPlayerIds([])}
                >
                  Tout retirer
                </button>
              ) : null}
            </div>

            <label className="field">
              <span>Recherche avec auto completion</span>
              <input
                type="search"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && suggestions[0]) {
                    event.preventDefault()
                    addPlayer(suggestions[0])
                  }

                  if (event.key === 'Escape') {
                    setSearchTerm('')
                  }
                }}
                placeholder={
                  importedData
                    ? 'Tape un nom de joueur ou de hero'
                    : "Importe d'abord un evenement"
                }
                disabled={!importedData}
              />
            </label>

            {suggestions.length ? (
              <div className="suggestions">
                {suggestions.map((player) => (
                  <button
                    key={player.id}
                    className="suggestion"
                    onClick={() => addPlayer(player)}
                  >
                    <PlayerAvatar player={player} />
                    <span className="suggestion-name">
                      <PlayerFlag countryCode={player.countryCode} />
                      {player.name}
                    </span>
                    <span className="suggestion-hero">
                      {player.heroName ?? 'Hero inconnu'}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}

            <div className="selected-tags">
              {selectedPlayers.length ? (
                selectedPlayers.map((player) => (
                  <button
                    key={player.id}
                    className="selected-tag"
                    onClick={() => removePlayer(player.id)}
                    title="Retirer ce joueur"
                  >
                    <span>{player.name}</span>
                    <strong>x</strong>
                  </button>
                ))
              ) : (
                <p className="empty-copy">
                  Aucun joueur selectionne pour le moment.
                </p>
              )}
            </div>
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Affichage</p>
                <h2>Overlay</h2>
              </div>
            </div>

            <label className="field">
              <span>Ronde publiee</span>
              <select
                value={activeRoundNumber ?? ''}
                onChange={(event) =>
                  setSelectedRound(
                    event.target.value ? Number.parseInt(event.target.value, 10) : null
                  )
                }
                disabled={!publishedRounds.length}
              >
                {publishedRounds.length ? null : (
                  <option value="">Aucune ronde disponible</option>
                )}
                {publishedRounds.map((round) => (
                  <option key={round.number} value={round.number}>
                    {round.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Titre overlay</span>
              <input
                type="text"
                value={customTitle}
                onChange={(event) => setCustomTitle(event.target.value)}
                placeholder={buildDefaultTitle(
                  importedData?.eventName ?? null,
                  activeRound?.label ?? null
                )}
              />
            </label>

            <div className="segmented-control" role="radiogroup" aria-label="Tri">
              <button
                className={sortMode === 'selection' ? 'is-active' : ''}
                onClick={() => setSortMode('selection')}
              >
                Ordre de selection
              </button>
              <button
                className={sortMode === 'score' ? 'is-active' : ''}
                onClick={() => setSortMode('score')}
              >
                Score decroissant
              </button>
            </div>

            <div className="button-row">
              <button
                className="primary-button"
                onClick={() => void handleExport()}
                disabled={!displayPlayers.length || isExporting}
              >
                {isExporting ? 'Export PNG...' : 'Telecharger le PNG'}
              </button>
            </div>

            <p className="helper-copy">
              Le fond de la zone exportee reste transparent. Les cartes joueurs
              conservent seulement leur propre habillage.
            </p>
          </article>
        </section>

        <section className="preview-column">
          <article className="panel preview-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Preview</p>
                <h2>Sortie OBS</h2>
              </div>
              <span className="preview-badge">Transparent</span>
            </div>

            <div className="preview-stage">
              <div className="checkerboard">
                <div className="overlay-root" ref={overlayRef}>
                  <div className="overlay-heading">
                    <span className="overlay-kicker">Tracked players</span>
                    <h3>{overlayTitle}</h3>
                    <p>
                      {activeRound?.label ?? 'Choisis une ronde'} - {displayPlayers.length}{' '}
                      joueur{displayPlayers.length > 1 ? 's' : ''}
                    </p>
                  </div>

                  <div className="overlay-list">
                    {displayPlayers.length ? (
                      displayPlayers.map(({ cumulativeRecord, player, record }) => (
                        <div
                          key={player.id}
                          className={`overlay-row ${record?.dropped ? 'is-dropped' : ''}`}
                        >
                          <div className="overlay-player">
                            <PlayerAvatar player={player} large />
                            <div className="overlay-player-copy">
                              <strong>
                                <PlayerFlag countryCode={player.countryCode} />
                                {player.name}
                              </strong>
                              <span>{player.heroName ?? 'Hero inconnu'}</span>
                            </div>
                          </div>

                          {record?.dropped ? (
                            <div className="score-pill is-dropped">Dropped</div>
                          ) : (
                            <div className="record-pills">
                              {buildRecordPills(cumulativeRecord).map((pill) => (
                                <div
                                  key={pill.key}
                                  className={`score-pill ${pill.className}`}
                                >
                                  {pill.label}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))
                    ) : (
                      <div className="overlay-empty">
                        Selectionne des joueurs pour generer la liste exportable.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </article>
        </section>
      </main>
    </div>
  )
}

export default App

function PlayerAvatar({
  player,
  large = false,
}: {
  large?: boolean
  player: ImportedPlayer
}) {
  if (player.heroImageUrl) {
    return (
      <img
        className={large ? 'player-avatar large' : 'player-avatar'}
        src={player.heroImageUrl}
        alt={player.heroName ?? player.name}
      />
    )
  }

  return (
    <div className={large ? 'player-avatar fallback large' : 'player-avatar fallback'}>
      {buildInitials(player.name)}
    </div>
  )
}

function PlayerFlag({ countryCode }: { countryCode: string | null }) {
  const flag = countryCode ? countryCodeToEmoji(countryCode) : ''

  if (!flag) {
    return <span className="player-flag fallback">??</span>
  }

  return (
    <span className="player-flag" title={countryCode ?? undefined}>
      {flag}
    </span>
  )
}

function buildDefaultTitle(
  eventName: string | null,
  roundLabel: string | null
): string {
  return [eventName ?? 'FAB Coverage', roundLabel ?? 'Round tracker'].join(' - ')
}

function summarizeRounds(
  player: ImportedPlayer,
  activeRoundNumber: number | null
): CumulativeRecord {
  const summary: CumulativeRecord = {
    draws: 0,
    losses: 0,
    wins: 0,
  }

  if (activeRoundNumber === null) {
    return summary
  }

  for (const [roundKey, record] of Object.entries(player.rounds)) {
    const roundNumber = Number.parseInt(roundKey, 10)

    if (Number.isNaN(roundNumber) || roundNumber > activeRoundNumber || !record.result) {
      continue
    }

    if (record.result === 'W') {
      summary.wins += 1
    } else if (record.result === 'L') {
      summary.losses += 1
    } else if (record.result === 'D') {
      summary.draws += 1
    }
  }

  return summary
}

function buildRecordPills(cumulativeRecord: CumulativeRecord): Array<{
  className: string
  key: string
  label: string
}> {
  const pills = []

  if (cumulativeRecord.wins > 0) {
    pills.push({
      className: 'is-win',
      key: 'wins',
      label: `${cumulativeRecord.wins}W`,
    })
  }

  if (cumulativeRecord.losses > 0) {
    pills.push({
      className: 'is-loss',
      key: 'losses',
      label: `${cumulativeRecord.losses}L`,
    })
  }

  if (cumulativeRecord.draws > 0) {
    pills.push({
      className: 'is-draw',
      key: 'draws',
      label: `${cumulativeRecord.draws}D`,
    })
  }

  if (!pills.length) {
    pills.push({
      className: 'is-neutral',
      key: 'empty',
      label: 'N/A',
    })
  }

  return pills
}

function normalizeSearchValue(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function buildInitials(value: string): string {
  const initials = value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')

  return initials || '?'
}

function countryCodeToEmoji(countryCode: string): string {
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return ''
  }

  return String.fromCodePoint(
    ...[...countryCode].map((char) => 127397 + char.charCodeAt(0))
  )
}

function buildFileName(eventName: string, roundLabel: string): string {
  const slug = `${eventName}-${roundLabel}`
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()

  return `${slug || 'fab-overlay'}.png`
}

function loadSettings(): PersistedSettings {
  try {
    const rawSettings = window.localStorage.getItem(SETTINGS_KEY)

    if (!rawSettings) {
      return {
        customTitle: '',
        eventUrl: DEFAULT_EVENT_URL,
        selectedPlayerIds: [],
        selectedRound: null,
        sortMode: 'selection',
      }
    }

    const parsed = JSON.parse(rawSettings) as Partial<PersistedSettings>

    return {
      customTitle: typeof parsed.customTitle === 'string' ? parsed.customTitle : '',
      eventUrl:
        typeof parsed.eventUrl === 'string' && parsed.eventUrl
          ? parsed.eventUrl
          : DEFAULT_EVENT_URL,
      selectedPlayerIds: Array.isArray(parsed.selectedPlayerIds)
        ? parsed.selectedPlayerIds.filter((value): value is string => typeof value === 'string')
        : [],
      selectedRound:
        typeof parsed.selectedRound === 'number' ? parsed.selectedRound : null,
      sortMode: parsed.sortMode === 'score' ? 'score' : 'selection',
    }
  } catch {
    return {
      customTitle: '',
      eventUrl: DEFAULT_EVENT_URL,
      selectedPlayerIds: [],
      selectedRound: null,
      sortMode: 'selection',
    }
  }
}

function saveSettings(settings: PersistedSettings) {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}
