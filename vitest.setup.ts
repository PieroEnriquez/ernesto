// Disable GPG signing for any git operations triggered by tests.
// Several test suites use real git fixtures (lint-workspace, derive-worker
// integration, workdir kernel). Without this, the host's commit.gpgsign=true
// prompts pinentry / YubiKey for every test commit.
process.env.GIT_CONFIG_PARAMETERS = "'commit.gpgsign=false' 'tag.gpgsign=false'";
