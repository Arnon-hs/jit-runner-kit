.PHONY: check shellcheck test terraform-fmt terraform-validate

check: shellcheck test terraform-fmt terraform-validate

shellcheck:
	shellcheck bin/jit-runner bin/jit-runner-controller remote/start-jit-runner.sh tests/test-cli.sh

test:
	bash tests/test-cli.sh

terraform-fmt:
	terraform -chdir=providers/hetzner fmt -check -recursive

terraform-validate:
	terraform -chdir=providers/hetzner init -backend=false -input=false
	terraform -chdir=providers/hetzner validate
