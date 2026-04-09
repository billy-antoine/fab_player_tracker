export type RoundScore = {
  dropped: boolean
  result: 'W' | 'L' | 'D' | null
  rank: string | null
  wins: number | null
}

export type ImportedPlayer = {
  countryCode: string | null
  heroImageUrl: string | null
  heroName: string | null
  id: string
  name: string
  rounds: Record<string, RoundScore>
}

export type ImportedRound = {
  label: string
  number: number
  pairingsUrl: string | null
  resultsUrl: string | null
  standingsPublished: boolean
  standingsUrl: string | null
}

export type ImportedTournament = {
  defaultRound: number | null
  eventName: string
  eventUrl: string
  importedAt: string
  players: ImportedPlayer[]
  rounds: ImportedRound[]
}
