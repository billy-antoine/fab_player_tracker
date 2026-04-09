# FAB Player Tracker

Application web pour importer un event Flesh and Blood depuis une page de coverage `fabtcg.com`, choisir des joueurs a suivre, afficher leur etat a une ronde donnee, puis exporter une liste en image transparente pour OBS.

## Fonctionnalites

- import d'un event via une URL `fabtcg.com/coverage/...`
- recuperation des joueurs inscrits, des rondes et des standings publies
- recherche avec auto-completion sur les noms de joueurs et de heros
- selection manuelle des joueurs a tracker
- choix de la ronde a afficher
- affichage du hero, du nom du joueur et de son score actuel
- affichage `Dropped` si le joueur a drop
- export PNG a fond transparent pour integration dans OBS

## Prerequis

- Node.js 24+
- npm

## Installation

```bash
npm install
```

## Lancer le projet

En developpement :

```bash
npm run dev
```

Puis ouvrir :

```text
http://localhost:5173
```

Le frontend Vite tourne sur `5173` et l'API locale de parsing tourne sur `8787`.

## How To Use

1. Lance l'application avec `npm run dev`.
2. Colle un lien d'evenement FabTCG, par exemple :

```text
https://fabtcg.com/coverage/calling-toulouse/
```

3. Clique sur `Charger l'evenement`.
4. Attends l'import des joueurs et des rondes publiees.
5. Dans `Joueurs a tracker`, utilise la barre de recherche pour trouver un joueur.
6. Clique sur un resultat pour l'ajouter a la liste suivie.
7. Dans `Overlay`, choisis la ronde a afficher.
8. Optionnel : modifie le titre de l'overlay.
9. Clique sur `Telecharger le PNG`.
10. Ajoute le PNG exporte comme source image dans OBS.

## Score Affiche

Le score affiche correspond actuellement au nombre de `wins` publie dans les standings FabTCG pour la ronde selectionnee.

Si un joueur est marque comme `Dropped` dans les standings, l'overlay affiche `Dropped`.

## Commandes Utiles

```bash
npm run dev
npm run build
npm run lint
npm run start
```

## Structure

- `src/` : interface React
- `server/` : API locale Express et parsing HTML des pages FabTCG
- `dist/` : build de production

## Notes

- Le parser est concu pour les pages de coverage `fabtcg.com`.
- Les images de heros sont proxifiees localement pour faciliter l'export image.
- Les selections et reglages principaux sont conserves dans le `localStorage` du navigateur.
