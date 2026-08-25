variable "run_key" {
  description = "Unique, label-safe workflow run key."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.run_key))
    error_message = "run_key must contain only lowercase letters, numbers, and hyphens."
  }
}

variable "server_name" {
  description = "Temporary server name."
  type        = string
}

variable "server_type" {
  description = "Hetzner Cloud server type."
  type        = string
  default     = "cx33"
}

variable "location" {
  description = "Hetzner Cloud location."
  type        = string
  default     = "fsn1"
}

variable "image" {
  description = "Hetzner Cloud image name."
  type        = string
  default     = "ubuntu-24.04"
}

variable "public_key" {
  description = "Ephemeral SSH public key."
  type        = string
}

variable "ssh_host_private_key" {
  description = "Ephemeral SSH server host private key used for controller-side pinning."
  type        = string
  sensitive   = true
}

variable "ssh_host_public_key" {
  description = "Ephemeral SSH server host public key used for controller-side pinning."
  type        = string
}

variable "ssh_allowed_cidr" {
  description = "IPv4 CIDR allowed to reach SSH."
  type        = string
}

variable "expires_at" {
  description = "Unix epoch used by the independent TTL sweeper."
  type        = number
}
