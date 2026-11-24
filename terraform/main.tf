resource "terraform_data" "this" {
  triggers_replace = "base"

  # To test failed applies.
  provisioner "local-exec" {
    command = "test ! -e \"$FAIL_APPLY\""
  }
}
