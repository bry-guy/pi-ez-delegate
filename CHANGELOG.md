# Changelog

## [1.1.0](https://github.com/bry-guy/pi-ez-delegate/compare/v1.0.0...v1.1.0) (2026-03-28)


### Features

* add --model flag and delegate context guidance ([8645818](https://github.com/bry-guy/pi-ez-delegate/commit/86458181939a2eae89d93c5f3241a29013520c45))
* add delegate config and registry foundations ([eb2c828](https://github.com/bry-guy/pi-ez-delegate/commit/eb2c828fbc76f144c071ff0b2b69c984998e8832))
* add registry and config foundations ([1de8176](https://github.com/bry-guy/pi-ez-delegate/commit/1de8176f853f2bd18139d47dee44d30a4c7e7553))
* allow minPaneRows=0 to disable pane row limit ([5b6dae3](https://github.com/bry-guy/pi-ez-delegate/commit/5b6dae3a9fd935dab9aeab3bb838f2927d1585e8))
* anchor pane launches to stored tmux origin ([e19a2d7](https://github.com/bry-guy/pi-ez-delegate/commit/e19a2d7d4bb9e80090ef1b1da9191e93ac9f2060))
* compact parent session before forking delegates ([7ac5de0](https://github.com/bry-guy/pi-ez-delegate/commit/7ac5de0346a92ba3ac870bcad659fdc9c6741e2a))
* hierarchical delegate session naming with auto-generated parent names ([338be1a](https://github.com/bry-guy/pi-ez-delegate/commit/338be1a21cc125298bf844e914eb06e1f0391909))
* implement tmux worker delegation via /ezdg ([101c542](https://github.com/bry-guy/pi-ez-delegate/commit/101c542493732f446cf1e3605a1ceb01f6b42f41))
* wire --split flag and --no-automerge into delegate launch path ([475dc2c](https://github.com/bry-guy/pi-ez-delegate/commit/475dc2cbb5af48cf828ddb0d2ac76bd261191825))
* wire config-driven defaults into extension ([13ac6df](https://github.com/bry-guy/pi-ez-delegate/commit/13ac6df68a5e311e16de4b3dd26bef302eb83498))


### Bug Fixes

* address delegated worker isolation and liveness bugs ([f688436](https://github.com/bry-guy/pi-ez-delegate/commit/f6884360a52514aea11bc91cb4be55a33e03e786))
* harden delegate worktree isolation and add finish flow ([6ad0ea1](https://github.com/bry-guy/pi-ez-delegate/commit/6ad0ea1e0ecf9d99fc00c01428c881c4d1f1e504))
* launch worker tmux pane from main checkout and auto-close on exit ([fa071ea](https://github.com/bry-guy/pi-ez-delegate/commit/fa071ea36c70739b4c0ba0bbd44efced97b2c33c))
* lower default minPaneColumns from 180 to 120 for auto vertical split ([9dd41b0](https://github.com/bry-guy/pi-ez-delegate/commit/9dd41b03c9617e421689303d2315dbe4764a8358))
* prevent delegated workers from spawning delegates ([08752f3](https://github.com/bry-guy/pi-ez-delegate/commit/08752f3e01897758066b03bc1d025eb1ad33ba5a))
* prevent recursive delegation by hiding delegate_task tool from delegated workers ([5429c64](https://github.com/bry-guy/pi-ez-delegate/commit/5429c647e0d1fb1b22a858014e7a28ba5f32a36b))
* rebind stale tmux origins and use shared delegates window ([132d869](https://github.com/bry-guy/pi-ez-delegate/commit/132d8697f607f78de05a9e482c8776af55bfd449))
* serialize delegate panes and improve finish flow ([6666e8b](https://github.com/bry-guy/pi-ez-delegate/commit/6666e8b5c8beeca26e3da280dcff44a9b474dcdd))
* serialize pane launches and exit delegates by default ([d691d58](https://github.com/bry-guy/pi-ez-delegate/commit/d691d5897b75ae113367d8faf1729fd27006f65b))
* strip delegate_task tool calls from forked session history ([8013f2d](https://github.com/bry-guy/pi-ez-delegate/commit/8013f2d882bc75ae2c332e508b6347c048bcbb7b))
* use getAllTools() in session_start handler to prevent wiping all tools ([2064211](https://github.com/bry-guy/pi-ez-delegate/commit/2064211987a568dfe8cac60cf8f76787481ef95c))

## [1.0.0] - 2026-03-12

- Initial scaffold for `pi-ez-delegate`
