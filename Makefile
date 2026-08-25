IAC ?= tofu

.PHONY: check shellcheck test serverless iac-fmt iac-validate

check: shellcheck test serverless iac-fmt iac-validate

shellcheck:
	shellcheck bin/jit-runner bin/jit-runner-controller remote/start-jit-runner.sh tests/test-cli.sh

test:
	bash tests/test-cli.sh

serverless:
	npm run check:serverless

iac-fmt:
	$(IAC) -chdir=providers/hetzner fmt -check -recursive

iac-validate:
	$(IAC) -chdir=providers/hetzner init -backend=false -input=false
	$(IAC) -chdir=providers/hetzner validate
