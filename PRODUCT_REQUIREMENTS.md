# Product Requirements

> Source: the Production Control Hub master build directive supplied by the product architect (reproduced unchanged below). Implementation status against each acceptance criterion is tracked in [docs/TEST_REPORT.md](docs/TEST_REPORT.md).

---


## ROLE

You are the Lead Software Engineer and Infrastructure Architect for **Production Control Hub (PCH)**.

Your responsibility is to design, implement, test, document, and deliver a functioning production-control application that reproduces the software control experience of an Elgato Stream Deck XL, using Bitfocus Companion as its primary automation and hardware-integration engine.

ChatGPT serves as Product Architect and defines the product requirements. You are responsible for engineering implementation, infrastructure, frontend development, backend development, integration testing, and technical documentation.

**Do not stop after creating a prototype, UI mockup, or project skeleton. Implement a working application and verify it through automated tests.**

Work autonomously through implementation decisions that remain consistent with this specification. Document assumptions and escalate only genuine architectural blockers or decisions requiring hardware access or credentials.

---

## 1. PRODUCT OBJECTIVE

Build a professional, browser-based virtual Stream Deck XL with a fully customizable 32-key control surface.

The application must work on:

- Windows desktop and laptop browsers
- macOS browsers
- iPadOS Safari
- Android tablet browsers
- Touchscreen Windows devices

The system must not require a physical Stream Deck or a native iPad application.

Bitfocus Companion may run on a separate computer connected to the same network.

Production Control Hub must be able to communicate with that remote Companion instance.

The application must operate locally without cloud infrastructure or internet access after installation and configuration.

---

## 2. CORE ARCHITECTURE

Implement a modular, three-tier architecture.

### Frontend
React + TypeScript + Vite.

Responsibilities:
- Virtual 32-key control surface
- Button image rendering
- Live button state and tally
- Touch and mouse interaction
- Pages and folders
- Profile management
- Configuration interface
- Responsive layouts
- Connection indicators
- Operator authentication

### Backend
Node.js + TypeScript.

Responsibilities:
- Companion connection management
- Satellite protocol client
- HTTP control adapter where appropriate
- WebSocket communication with browsers
- Connection health monitoring
- State synchronization
- Authentication and authorization
- Profile and configuration persistence
- Event logging
- Multi-client coordination

### Companion
An independently running Bitfocus Companion instance.

Responsibilities:
- ATEM device control
- vMix control
- Supported device modules
- Hardware feedback
- Action execution
- Companion-managed macros
- Production automation

Do not duplicate Companion's device protocol implementations unnecessarily.

---

## 3. STREAM DECK XL FUNCTIONAL PARITY

The application must provide a virtual control surface modeled on the Stream Deck XL.

### Physical layout equivalent
- Exactly 32 visible key positions
- Eight columns
- Four rows
- Square keys
- Individual key labels
- Individual key images
- Clear pressed-state indication
- Configurable spacing and sizing
- Responsive scaling

Support 96 × 96-pixel key artwork as a baseline while rendering sharply on high-resolution displays.

### Button appearance
Support:
- Custom background colors
- Custom text
- Text placement
- Font sizes
- Icons
- Uploaded images
- Dynamic button images
- Multiple visual states
- Disabled/unavailable states
- Program/preview tally indicators
- Connection feedback

Companion-provided button images and states must take precedence where Companion owns the visual configuration.

### Button interactions
Support:
- Press
- Release
- Momentary actions
- Toggle/latching actions
- Press-and-hold
- Double press
- Single press
- Multi-action triggering

Distinguish between features directly supported by Companion and additional PCH-managed interaction logic.

Avoid double-triggering actions when both systems implement press logic.

### Navigation
Implement:
- Multiple pages
- Previous/next page
- Direct page navigation
- Nested folders
- Folder back navigation
- Profile switching
- Optional pinned navigation controls

Maintain predictable navigation across refreshes and reconnections.

### Profiles
Support:
- Create profile
- Rename profile
- Duplicate profile
- Delete profile
- Import/export profile
- Assign Companion page mappings
- Persist layout preferences

Prepare the architecture for future context-aware Smart Profiles.

### Multi-actions
Use Companion's existing stacked, delayed, and conditional actions wherever supported.

Expose an intuitive configuration experience without creating a conflicting second automation engine.

Advanced macro editing may initially open the corresponding Companion configuration interface.

---

## 4. COMPANION INTEGRATION

This is the most important backend subsystem.

Research the actual Companion version and available protocol documentation before implementing the adapter.

Evaluate:
- Satellite TCP interface
- Satellite WebSocket interface
- Companion HTTP remote-control interface
- Version-dependent REST capabilities
- Button image and feedback events
- Page selection
- Press/release semantics
- Authentication and network restrictions

Do not assume undocumented API endpoints or protocol messages.

Build a dedicated CompanionAdapter abstraction.

Required methods should conceptually include:

- connect()
- disconnect()
- reconnect()
- pressButton()
- releaseButton()
- selectPage()
- getConnectionState()
- subscribeToButtonUpdates()
- subscribeToConnectionUpdates()

Adapt method signatures to verified protocol capabilities.

### Connection configuration
The user must be able to enter:
- Companion host/IP address
- Companion control port
- Satellite transport
- Authentication settings where supported
- Connection timeout
- Reconnection policy

Never hardcode production IP addresses.

### Reconnection
Implement:
- Connection-loss detection
- Exponential backoff
- Reconnection status
- State resynchronization
- Stale-image handling
- Safe release of pressed buttons
- No automatic replay of previously executed commands

The application must never execute an unintended production command simply because a connection has been restored.

---

## 5. iPAD AND MOBILE EXPERIENCE

Implement a Progressive Web App.

Requirements:
- Safari compatibility
- Home Screen installation
- Landscape-oriented 8 × 4 grid
- Fullscreen-friendly interface
- Touchscreen interaction
- No accidental text selection
- No unwanted scrolling during button presses
- Pointer-event handling
- Pointer cancellation handling
- Visual press feedback
- Support for multiple simultaneous clients

A touch-and-hold interaction must not accidentally trigger Safari context menus.

Handle application backgrounding and network interruptions safely.

The PWA may cache the application shell, but must never suggest that hardware control remains operational when the backend is unreachable.

The browser connects to the PCH gateway; it must not require direct access to Companion.

---

## 6. USER INTERFACE DESIGN

Create a polished, professional broadcast-control interface.

Visual direction:
- Dark control-room aesthetic
- High contrast
- Large, readable controls
- Minimal unnecessary decoration
- Touch-friendly spacing
- Responsive layout
- Clear online/offline status
- Professional typography

### Operator View
The main screen must contain:
- 32-key virtual control grid
- Active profile name
- Active page name
- Companion connection indicator
- Edit mode toggle
- Settings access
- Fullscreen control

### Editor View
Create a visual configuration environment supporting:
- Button selection
- Label editing
- Icon selection
- Color selection
- Button-to-Companion mapping
- Profile management
- Page management
- Layout preview

Implement drag-and-drop editing where appropriate.

Never silently overwrite Companion-managed button imagery or action definitions.

### Settings View
Include:
- Companion connection settings
- Connection diagnostics
- Gateway status
- Authentication settings
- Display preferences
- Profile backup/export
- Application version

---

## 7. PRODUCTION EQUIPMENT INTEGRATIONS

The first supported equipment categories are:

### Blackmagic ATEM
Through Companion, support configured actions for:
- Program input selection
- Preview input selection
- CUT
- AUTO transition
- Upstream/downstream keying
- Media player controls where supported
- Switcher macro execution
- Program/preview tally feedback

### vMix
Through Companion, support configured actions for:
- Input selection
- Preview/program switching
- Video playback
- Stop/pause
- Overlays
- Audio mute
- Recording
- Streaming
- Status feedback

Do not hardcode a specific ATEM or vMix model.

Capabilities must depend on the actual connected device and Companion module.

Provide example Companion button mappings and test fixtures.

Do not require physical equipment for automated testing.

---

## 8. MULTI-CLIENT OPERATION

Multiple browsers may connect to the same gateway.

Requirements:
- Synchronized button states
- Synchronized connection status
- Consistent Companion feedback
- Per-client navigation where appropriate
- Configurable shared navigation behavior
- Protection against conflicting profile edits
- Session authentication
- Read-only operator mode

Avoid race conditions when multiple operators interact with the same control surface.

---

## 9. SECURITY

This application controls live production equipment and must be treated as an operational control system.

Implement:
- Authenticated gateway access
- Secure credential handling
- Input validation
- WebSocket origin validation
- Restricted network binding
- Rate limiting
- Session management
- Audit logging for significant actions
- No plaintext secrets in source control

Support HTTPS for trusted local-network deployment, including a documented certificate setup for iPadOS.

Do not expose Companion or PCH control endpoints to the public internet.

High-impact controls such as stopping a stream may support confirmation or an operator lock.

---

## 10. DATABASE AND PERSISTENCE

Use SQLite for local application persistence.

Store:
- Application settings
- Companion connection profiles
- Show profiles
- Pages
- Button presentation settings
- Companion mappings
- User preferences
- Operator accounts
- Audit records

Use database migrations and schema validation.

Companion remains authoritative for Companion-managed actions and feedback.

Do not duplicate sensitive Companion configuration unnecessarily.

---

## 11. PROJECT STRUCTURE

Use a TypeScript monorepo with a package manager such as pnpm.

Suggested structure:

production-control-hub/
- apps/web/
- apps/gateway/
- packages/shared/
- packages/companion-adapter/
- packages/ui/
- tests/unit/
- tests/integration/
- tests/e2e/
- docs/
- scripts/
- .github/workflows/

Maintain:
- README.md
- PRODUCT_REQUIREMENTS.md
- ARCHITECTURE.md
- CLAUDE.md
- CHANGELOG.md
- CONTRIBUTING.md
- .env.example

Include environment-specific configuration and setup scripts.

---

## 12. TESTING

Use automated tests throughout development.

Recommended:
- Vitest for unit tests
- Playwright for browser testing
- Mock Companion protocol server
- WebSocket integration tests
- TypeScript strict mode
- ESLint
- Production build validation

Test:
- 32-key rendering
- Correct button mapping
- Press/release events
- Long-press behavior
- Touch cancellation
- Connection loss
- Automatic reconnection
- Profile switching
- Folder navigation
- Multiple connected browsers
- State synchronization
- Unauthorized access prevention
- Database persistence

Mock hardware for automated tests.

Never execute production switcher or streaming commands during CI.

---

## 13. DEPLOYMENT

The application must support two primary deployment configurations.

### Configuration A
Companion and PCH gateway run on the same computer.

### Configuration B
Companion runs on Computer A.

PCH gateway runs on Computer B.

An iPad, Surface, or laptop connects to PCH through a browser over the production LAN.

Both configurations must be supported without changing application source code.

Provide:
- Windows installation instructions
- macOS installation instructions
- Linux installation instructions
- Development startup scripts
- Production startup scripts
- Environment variable examples
- Local network troubleshooting
- iPad connection instructions

Prefer simple local deployment without Docker as a requirement. Docker may be optional.

---

## 14. DEVELOPMENT PHASES

### Phase 0 — Protocol validation
Research Companion protocol compatibility.

Build a working protocol proof of concept.

Verify press/release and live button imagery against a supported Companion instance or documented test implementation.

Document version requirements.

### Phase 1 — Working control surface
Build:
- Gateway
- Companion adapter
- React frontend
- 8 × 4 button grid
- Press/release handling
- Live feedback
- Reconnection logic

### Phase 2 — Application management
Build:
- Settings interface
- Profiles
- Pages
- Folders
- Button editor
- Persistence
- Import/export

### Phase 3 — Tablet and production readiness
Build:
- PWA
- iPad optimization
- Authentication
- Multi-client synchronization
- Production diagnostics
- Deployment tooling

### Phase 4 — Validation
Run:
- Unit tests
- Integration tests
- End-to-end tests
- Network failure tests
- Security checks
- Build validation

Produce an operational readiness report.

---

## 15. ACCEPTANCE CRITERIA

The initial product is acceptable when:

1. The application starts successfully using documented instructions.
2. The browser displays 32 virtual buttons in an 8 × 4 grid.
3. The gateway connects to Companion on another LAN computer.
4. Pressing a virtual button sends the correct Companion press event.
5. Releasing the button sends the correct release event.
6. Companion button images and feedback appear in the interface.
7. Button states update without manually refreshing the browser.
8. The interface works in desktop browsers and iPad Safari.
9. Pages and profiles can be selected and persisted.
10. Multiple clients can connect without corrupting state.
11. Network interruption does not trigger unintended commands.
12. Automated tests pass.
13. The application can run without cloud hosting.
14. ATEM and vMix actions can be demonstrated through configured Companion buttons, with actual hardware validation performed separately.

---

## 16. ENGINEERING RULES

- Prefer existing, maintained libraries.
- Do not invent Companion API behavior.
- Verify compatibility with the actual Companion version.
- Keep the gateway independent of the frontend.
- Keep all device-control credentials server-side.
- Do not introduce unnecessary cloud dependencies.
- Avoid placeholder buttons that appear functional.
- Do not claim tests passed unless executed.
- Do not claim iPad compatibility without browser validation.
- Do not claim hardware compatibility without real hardware testing.
- Do not copy proprietary Elgato software, branding, or artwork.
- Use original application design and branding.
- Document any unimplemented feature clearly.
- Escalate security or production-safety decisions.

---

## 17. REQUIRED DELIVERABLES

Deliver:

1. Complete source code.
2. Functional React frontend.
3. Functional Node.js gateway.
4. Companion integration adapter.
5. SQLite persistence.
6. Profile and button configuration UI.
7. PWA configuration.
8. Automated test suite.
9. GitHub Actions CI.
10. Installation and deployment documentation.
11. Architecture documentation.
12. Companion configuration guide.
13. Test results and known limitations.
14. Next-phase development recommendations.

---

## 18. EXECUTION INSTRUCTIONS

Begin immediately with repository inspection and Companion protocol validation.

If the repository is empty, initialize the project.

If a project already exists, preserve working code and avoid unnecessary rewrites.

Implement the application incrementally with meaningful commits.

After each phase:
- Run applicable tests.
- Fix errors.
- Update documentation.
- Record outstanding limitations.
- Continue to the next phase unless blocked.

Do not request confirmation for routine implementation choices.

Do request approval before deploying to live production hardware, exposing services outside the local network, or making destructive changes.

**Final objective: Deliver a functional, locally hosted, iPad-compatible virtual Stream Deck XL powered by Bitfocus Companion, ready for controlled hardware testing.**