## [0.4.1](https://github.com/devp0nt/boot0/compare/v0.4.0...v0.4.1) (2026-05-29)


### Bug Fixes

* shutdown accepts a null exit code too ([030839b](https://github.com/devp0nt/boot0/commit/030839bf4a994f632b9ceaf709e2c921bb0f7d90))

# [0.4.0](https://github.com/devp0nt/boot0/compare/v0.3.0...v0.4.0) (2026-05-29)


### Features

* shutdown accepts a number or string exit code ([4cd105d](https://github.com/devp0nt/boot0/commit/4cd105d793d8fed1fb28f7823e6610cc7002a59e))

# [0.3.0](https://github.com/devp0nt/boot0/compare/v0.2.0...v0.3.0) (2026-05-29)


### Features

* onShutdown takes a name and registers a teardown-only service ([6fce198](https://github.com/devp0nt/boot0/commit/6fce198b38414910ef2c0a8e649eb48c3ec490c0))

# [0.2.0](https://github.com/devp0nt/boot0/compare/v0.1.0...v0.2.0) (2026-05-29)


### Features

* add shutdownOnUncaught and shutdownTimeoutMs, signal exit codes ([8041ecf](https://github.com/devp0nt/boot0/commit/8041ecf88dfeb13eeecadcc2d0929431e5099d3a))

# [0.1.0](https://github.com/devp0nt/boot0/compare/v0.0.0...v0.1.0) (2026-05-29)


### Features

* add getStatus and getOriginal instance helpers ([460e4a0](https://github.com/devp0nt/boot0/commit/460e4a04b3b929fa011fc98fa36561c929a79a17))
* add transformError to normalize thrown errors ([ee6248b](https://github.com/devp0nt/boot0/commit/ee6248bb5ef07baaae9893096a10ebc72f871930))
* infer the value type in getOriginal, startService, restartService ([e719319](https://github.com/devp0nt/boot0/commit/e719319dc0623d0fa084e3cc20a1f27b3a4a1092))
* log lifecycle events and pass a level to the logger ([d814e2b](https://github.com/devp0nt/boot0/commit/d814e2b361ca88c891b3a3289f1751de2720a389))
