# TI4 Lab

TI4 lab is a Twilight Imperium 4 drafting and map building tool. It supports multiple draft formats, has browser notifications, discord integration, and many other fun things.

## Prerequisites

### Dependencies

- Node.js
- Sqlite3

### Environment setup

In your shell configuration, add the following

```
export TI4_LAB_DATABASE_PATH="file:///ABSOLUTE_PATH_HERE.sqlite"
```

_NOTE_: The path must be an absolute path.

## Installing / running

Assuming all the prerequisites are met, you can run the following commands to install and run the app:

```shell
npm install --global yarn
yarn install
yarn run dev
```

Open `https://localhost:3000/` in your browser and you're good to go.

## Playing a game

A finished draft has a **Start Game** button. It carries the draft's map, factions, seats and speaker order into a game at `/game/<name>`, which everyone at the table opens and chooses who they are playing as.

The base game is always in play. Prophecy of Kings, Thunder's Edge and Codices I to IV are chosen when the game starts.

### What the game enforces

The rules engine (`app/game/engine`) runs the round structure and the rules that are the same in every game:

- strategy, action, status and agenda phases, initiative order and passing
- command tokens, fleet pool and capacity
- movement, including wormholes, hyperlanes and anomalies
- space cannon, anti-fighter barrage, space combat, bombardment, invasion and ground combat, with dice rolled by the server
- production, technology prerequisites and unit upgrades
- the eight strategy cards, objectives, agenda voting, transactions and victory points

### What players resolve themselves

Action cards, agendas, promissory notes, leaders, relics, exploration cards and faction abilities are shown in full but are not carried out automatically. When one is played, apply what it says from the **Adjust** tab; each change made there is recorded in the log.

A small number of technologies are applied for you: Antimass Deflectors, Gravity Drive, Light/Wave Deflector, Fleet Logistics, Neural Motivator, Hyper Metabolism, Sarween Tools, Plasma Scoring, Psychoarchaeology, AI Development Algorithm (prerequisites only) and Dark Energy Tap (frontier exploration only).

Thunder's Edge adds its factions, units, technologies, cards, relics and strategy cards. Its breakthroughs are tracked but their effects, the Fracture and galactic events are not implemented.

Seats are not protected by a login, in the same way drafts are not: anyone with the link can choose any player.

### Game data

Card and unit data in `app/game/data/generated` comes from the [AsyncTI4](https://github.com/AsyncTI4/TI4_map_generator_bot) data set, which is in the public domain. To refresh it:

```shell
npx tsx scripts/importGameData.ts
```
