#!/usr/bin/env bash
set -euo pipefail
exec bash -c "$(curl -fsSL https://raw.githubusercontent.com/erature-hub/cybara/main/site/public/install.sh)" install.sh "$@"
