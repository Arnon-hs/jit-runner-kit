terraform {
  required_version = ">= 1.7.0"

  required_providers {
    hcloud = {
      source  = "registry.terraform.io/hetznercloud/hcloud"
      version = "~> 1.68"
    }
  }
}

provider "hcloud" {}
