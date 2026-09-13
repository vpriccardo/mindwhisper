# Mindwhisper

A meditation audio prototype that generates looping ambient soundscapes with breath guidance from a single word. Built for mentalism experiments with TX (spectator) and RX (performer) modes.

## Live Demo

**Vercel Deployment:** https://temporary-turbo-atoll-hx45kq4.vercel.app

- **Landing page:** https://temporary-turbo-atoll-hx45kq4.vercel.app
- **TX Mode:** https://temporary-turbo-atoll-hx45kq4.vercel.app/tx
- **RX Mode:** https://temporary-turbo-atoll-hx45kq4.vercel.app/rx

*Note: This is a temporary deployment (expires in 60 min). To claim and make permanent, visit the claim URL provided by Vercel.*

## Two Modes

### TX Mode (Spectator) - `/tx`
Type a word → generates handshake + 15-second looping meditation audio with realistic inhale/exhale cues.

- Word-seeded deterministic ambient soundscapes
- Clear session handshake tone at start
- Realistic breath-in/breath-out audio cues
- Works fully offline after first load
- Simple UI: word input, start/stop controls

### RX Mode (Performer) - `/rx`
Companion page for listening and syncing with TX sessions.

- Microphone access for handshake detection
- Visual breath guidance synced to 15s cycle
- Session state console and timing display
- Ready for future decoder integration
- Real-time feedback for meditation sync

## Quick Start

### Production (Vercel)

Visit the live deployment at [URL TBD - deploying now]:

- **Landing page:** `/` - Choose TX or RX mode
- **TX (Spectator):** `/tx` - Generate meditation audio
- **RX (Performer):** `/rx` - Listen and sync

### Local Development

#### Option 1: Python HTTP Server

```bash
cd mindwhisper
python3 -m http.server 8080
```

Then open:
- http://localhost:8080/ - Landing page
- http://localhost:8080/tx.html - TX mode
- http://localhost:8080/rx.html - RX mode

### Option 2: Node.js HTTP Server (npx serve)

```bash
cd mindwhisper
npx serve -p 8080
```

Then open:
- http://localhost:8080/ - Landing page
- http://localhost:8080/tx.html - TX mode
- http://localhost:8080/rx.html - RX mode

### Option 3: Any Static Server

Serve the `mindwhisper` directory with any static file server. The app is just HTML + vanilla JavaScript.

## How It Works

### TX Mode (Spectator)

1. **Enter a word** (e.g., "peace", "calm", "ocean")
2. **Click "Start Session"**
3. **Listen** for the handshake tone (session start marker)
4. **Breathe** along with the cues:
   - Chime ascending = inhale (~2s into cycle)
   - Chime descending = exhale (~8.5s into cycle)
5. The 15-second loop repeats continuously
6. **Click "Stop"** when done

### RX Mode (Performer)

1. **Click "Start Listening"** to arm microphone
2. **Console** shows handshake detection status
3. **Breath circle** animates: expands for inhale, contracts for exhale
4. **Session timer** tracks meditation duration
5. Visual guidance synced to 15-second breath cycle
6. **Click "Stop"** to end listening session

## Technical Details

### Audio Generation (TX)

- **Web Audio API**: All sounds synthesized in-browser (no downloads)
- **Deterministic**: Same word always produces same ambience
- **Layered synthesis**: 5 sine wave layers with seeded frequencies (80-380 Hz)
- **Breath cues**: Simple sine tone envelopes (440-550 Hz inhale, 440-330 Hz exhale)
- **Handshake**: 528-396 Hz descending tone (~1.2s duration)

### Handshake Detection (RX)

- **Microphone access** via Web Audio API
- **Signal analysis** with AnalyserNode (v1: simulated detection after 2s)
- **Real-time visualization** of breath phases
- **Console logging** of session events
- **Future**: Frequency analysis for actual handshake detection

### Offline Support

- No external dependencies after page load
- No audio files to download
- Pure JavaScript + Web Audio API
- Works in airplane mode after first visit (browser cache handles HTML/JS)

### Timing

- **Loop cycle**: 15 seconds
- **Inhale cue**: ~2 seconds into loop (5 second inhale phase)
- **Exhale cue**: ~8.5 seconds into loop (5 second exhale phase)
- **Handshake**: 1.5 seconds before loop starts

## Browser Compatibility

Works in modern browsers supporting Web Audio API:
- Chrome/Edge 70+
- Firefox 76+
- Safari 14+

**Note**: Autoplay policies require user interaction (button click) to start audio.

## Deployment

### Vercel

```bash
cd /workspace
vercel --prod
```

Routes configured in `vercel.json`:
- `/` → Landing page
- `/tx` → TX mode (spectator)
- `/rx` → RX mode (performer)

### Other Platforms

Deploy the entire repository. The `mindwhisper/` directory contains all static assets. Configure routes:
- `/` → `/mindwhisper/index.html`
- `/tx` → `/mindwhisper/tx.html`
- `/rx` → `/mindwhisper/rx.html`

## Known Limitations

### TX Mode
- No visual breath animation (v1 prototype)
- No session recording/playback
- Fixed 15-second cycle (no customization yet)

### RX Mode
- Handshake detection simulated (2s delay) - real frequency analysis TBD
- No actual word decoding yet (decoder pipeline ready for future)
- Microphone required for session sync

## File Structure

```
mindwhisper/
├── index.html         # Landing page (choose TX or RX)
├── tx.html            # TX mode - spectator interface
├── tx-app.js          # TX UI logic and event handlers
├── rx.html            # RX mode - performer interface
├── rx-app.js          # RX UI logic and handshake detection
├── audio-engine.js    # Core audio synthesis engine (shared)
└── README.md          # This file

vercel.json            # Vercel deployment config (routes)
```

## Future Enhancements

### TX Mode
- Visual breath animation synced to audio
- Adjustable loop length and breath timing
- Word encoding into audio steganography

### RX Mode
- Real handshake frequency detection (528→396 Hz)
- Word decoder from steganographic channel
- Session recording and analysis
- Multi-performer sync

## Architecture Notes

- **Pure client-side**: No backend, all processing in-browser
- **Offline-first**: Service Worker ready (cache on first load)
- **Deterministic**: Word → hash → ambience parameters (reproducible)
- **Modular**: TX and RX share audio-engine.js but operate independently

## License

Part of the Mentalism Engine v2 project. See repository root for details.
