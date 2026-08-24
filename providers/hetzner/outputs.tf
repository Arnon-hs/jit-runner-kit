output "server_id" {
  description = "Temporary Hetzner server ID."
  value       = hcloud_server.runner.id
}

output "public_ipv4" {
  description = "Temporary runner public IPv4."
  value       = hcloud_primary_ip.runner.ip_address
}

