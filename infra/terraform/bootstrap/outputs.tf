output "state_bucket" {
  description = "Name of the Terraform state bucket. Referenced by each environment's backend.tf."
  value       = google_storage_bucket.tfstate.name
}

output "workload_identity_provider" {
  description = "Full provider resource name for google-github-actions/auth. Set as the WIF_PROVIDER repository variable."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "tf_plan_service_account" {
  description = "Read-only identity used by pull-request plans."
  value       = google_service_account.tf_plan.email
}

output "tf_apply_service_account" {
  description = "Apply identity, restricted to the default branch."
  value       = google_service_account.tf_apply.email
}

output "run_noperm_service_account" {
  description = "Runtime account for Cloud Run services that need no GCP access. Pass it as `service_account_email`; it holds no role, which is what makes the apply identity's actAs on it harmless."
  value       = google_service_account.run_noperm.email
}

output "android_signing_service_account" {
  description = "Set this as the ANDROID_SIGNING_SERVICE_ACCOUNT repo variable. Until it is set, releases build an UNSIGNED .aab and record signed:false — which is the honest default, not a failure."
  value       = google_service_account.android_signing.email
}
