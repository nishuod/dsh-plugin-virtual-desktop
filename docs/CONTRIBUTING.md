# Contributing

This project is an auditable Windows execution layer with replaceable models. v1 supports Windows x64 only. Autonomous visual tasks are experimental and disabled by default. Arbitrary shell execution, model weights, model training and benchmark score promises are outside scope.

Use Node >=24.9 and .NET 8 SDK on Windows x64. Run `npm ci --ignore-scripts`, `npm run build`, `npm test` and `npm run verify:package`. Do not edit dependencies in `node_modules`. Build output is generated; change `src` or `prototype/ChildSessionHost` instead. `npm test` uses controlled fixtures and does not send live desktop input.

Each behavioral change needs a stable failing reproduction, a meaningful regression test and a `docs/TEST_REPORT_*` report distinguishing unit, integration and live evidence. Existing safety assertions must remain intact: connectionId, epoch, child session, PID, one-use frames, immediate revocation and no main-desktop fallback. Public tools and fields require updates to `docs/PUBLIC-API.md` and `CHANGELOG.md`. Do not include secrets, real user screenshots or local usernames in committed evidence.

Live evaluation is opt-in. Read `evals/README.md` and use only a dedicated fixture window and disposable test assets. Do not claim the scenario catalog or mocked tests prove end-user readiness.

Release maintainers follow `docs/RELEASING.md`. Publishing requires the repository owner to configure a protected `npm-publication` environment and `NPM_TOKEN`; preparing a release never publishes it.
