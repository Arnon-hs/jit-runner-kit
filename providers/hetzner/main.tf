locals {
  labels = {
    managed_by = "jit-runner-kit"
    run_key    = var.run_key
    expires_at = tostring(var.expires_at)
  }
}

resource "hcloud_ssh_key" "runner" {
  name       = "${var.server_name}-key"
  public_key = var.public_key
  labels     = local.labels
}

resource "hcloud_primary_ip" "runner" {
  name        = "${var.server_name}-ipv4"
  location    = var.location
  type        = "ipv4"
  auto_delete = true
  labels      = local.labels
}

resource "hcloud_firewall" "runner" {
  name   = "${var.server_name}-firewall"
  labels = local.labels

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = [var.ssh_allowed_cidr]
  }
}

resource "hcloud_server" "runner" {
  name        = var.server_name
  image       = var.image
  server_type = var.server_type
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.runner.id]
  firewall_ids = [
    hcloud_firewall.runner.id,
  ]
  labels = local.labels
  user_data = templatefile("${path.module}/cloud-init.yaml", {
    ssh_host_private_key_b64 = base64encode(var.ssh_host_private_key)
    ssh_host_public_key_b64  = base64encode(var.ssh_host_public_key)
  })

  public_net {
    ipv4_enabled = true
    ipv4         = hcloud_primary_ip.runner.id
    ipv6_enabled = false
  }
}
