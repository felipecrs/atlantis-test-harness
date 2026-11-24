variable "v" {
  default = "base"
}

resource "terraform_data" "this" {
  input            = var.v
  triggers_replace = var.v

  # To test failed applies.
  provisioner "local-exec" {
    command = "test ! -e \"$HARNESS_WORK/fail-apply\""
  }
}
