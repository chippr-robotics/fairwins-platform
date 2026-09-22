# Frontend Deployment to Google Cloud Run

This document describes how to deploy the React frontend application to Google Cloud Run using GitHub Actions.

> **Note**: Throughout this document, replace placeholder values like `YOUR_GITHUB_ORG`, `YOUR_REPO_NAME`, `my-project-123`, etc. with your actual values.

## Overview

The deployment workflow automatically:
1. Builds the React application using Vite
2. Creates a Docker container image with nginx
3. Pushes the image to Google Artifact Registry
4. Deploys the container to Google Cloud Run

## Prerequisites

### Google Cloud Setup

1. **Google Cloud Project**
   - Create or use an existing GCP project
   - Note the Project ID

2. **Enable Required APIs**
   ```bash
   gcloud services enable \
     cloudrun.googleapis.com \
     artifactregistry.googleapis.com \
     cloudbuild.googleapis.com
   ```

3. **Create Artifact Registry Repository**
   ```bash
   gcloud artifacts repositories create prediction-dao \
     --repository-format=docker \
     --location=us-central1 \
     --description="Docker repository for Prediction DAO"
   ```

### Authentication Methods

You can choose between two authentication methods:

#### Option 1: Workload Identity Federation (Recommended)

Workload Identity Federation allows GitHub Actions to authenticate to Google Cloud without storing long-lived service account keys.

1. **Create a Service Account**
   ```bash
   gcloud iam service-accounts create github-actions-deployer \
     --display-name="GitHub Actions Deployer"
   ```

2. **Grant Required Permissions**
   ```bash
   # Get your project number
   PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
   
   # Grant Cloud Run Admin role
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:github-actions-deployer@$PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/run.admin"
   
   # Grant Artifact Registry Writer role
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:github-actions-deployer@$PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/artifactregistry.writer"
   
   # Grant Service Account User role (for Cloud Run)
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:github-actions-deployer@$PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/iam.serviceAccountUser"
   ```

3. **Create Workload Identity Pool**
   ```bash
   gcloud iam workload-identity-pools create "github-pool" \
     --location="global" \
     --display-name="GitHub Actions Pool"
   ```

4. **Create Workload Identity Provider**
   ```bash
   gcloud iam workload-identity-pools providers create-oidc "github-provider" \
     --location="global" \
     --workload-identity-pool="github-pool" \
     --display-name="GitHub Provider" \
     --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
     --attribute-condition="assertion.repository_owner == 'YOUR_GITHUB_ORG'" \
     --issuer-uri="https://token.actions.githubusercontent.com"
   ```

5. **Grant Workload Identity User Role**
   ```bash
   gcloud iam service-accounts add-iam-policy-binding \
     "github-actions-deployer@$PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/iam.workloadIdentityUser" \
     --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/attribute.repository/YOUR_GITHUB_ORG/YOUR_REPO_NAME"
   ```

6. **Get Workload Identity Provider Resource Name**
   ```bash
   gcloud iam workload-identity-pools providers describe "github-provider" \
     --location="global" \
     --workload-identity-pool="github-pool" \
     --format="value(name)"
   ```
   
   This will output something like:
   ```
   projects/123456789/locations/global/workloadIdentityPools/github-pool/providers/github-provider
   ```

#### Option 2: Service Account Key (Simpler, Less Secure)

1. **Create a Service Account**
   ```bash
   gcloud iam service-accounts create github-actions-deployer \
     --display-name="GitHub Actions Deployer"
   ```

2. **Grant Required Permissions**
   ```bash
   # Grant Cloud Run Admin role
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:github-actions-deployer@$PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/run.admin"
   
   # Grant Artifact Registry Writer role
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:github-actions-deployer@$PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/artifactregistry.writer"
   
   # Grant Service Account User role
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:github-actions-deployer@$PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/iam.serviceAccountUser"
   ```

3. **Create and Download Service Account Key**
   ```bash
   gcloud iam service-accounts keys create key.json \
     --iam-account=github-actions-deployer@$PROJECT_ID.iam.gserviceaccount.com
   ```
   
   **⚠️ Important**: Store this key securely and never commit it to version control.

## GitHub Secrets Configuration

Configure the following secrets in your GitHub repository:
**Settings → Secrets and variables → Actions → New repository secret**

### Required Secrets for Workload Identity Federation

- `GCP_PROJECT_ID`: Your Google Cloud Project ID (e.g., `my-project-123`)
- `GCP_REGION`: Region for Cloud Run and Artifact Registry (e.g., `us-central1`)
- `ARTIFACT_REGISTRY_REPO`: Name of your Artifact Registry repository (e.g., `prediction-dao`)
- `WIF_PROVIDER`: Full resource name of the Workload Identity Provider (from step 6 above)
- `WIF_SERVICE_ACCOUNT`: Service account email (e.g., `github-actions-deployer@my-project-123.iam.gserviceaccount.com`)

### Required Secrets for Service Account Key Method

If using service account key authentication instead:
- `GCP_PROJECT_ID`: Your Google Cloud Project ID
- `GCP_REGION`: Region for Cloud Run and Artifact Registry
- `ARTIFACT_REGISTRY_REPO`: Name of your Artifact Registry repository
- `GCP_SA_KEY`: Contents of the service account key JSON file (entire JSON content)

**Note**: When using service account keys, you need to uncomment the alternative authentication blocks in the workflow file.

## Workflow Configuration

### Automatic Triggers

The workflow runs automatically on:
- **Push to main or develop branches** (with changes to frontend/ or workflow file)
- **Pull requests to main or develop branches** (builds but doesn't deploy)

### Manual Trigger

You can manually trigger the workflow:
1. Go to **Actions** tab in GitHub
2. Select **Build and Deploy Frontend to Cloud Run**
3. Click **Run workflow**
4. Choose the branch and click **Run workflow**

## Workflow Stages

### 1. Build and Push
- Checks out the code
- Sets up Docker Buildx for efficient builds
- Authenticates to Google Cloud
- Configures Docker for Artifact Registry
- Builds the Docker image with caching
- Pushes the image to Artifact Registry

### 2. Deploy
- Only runs on pushes to main or develop branches
- Authenticates to Google Cloud
- Deploys the container to Cloud Run
- Outputs the service URL

## Container Configuration

### Dockerfile
The `frontend/Dockerfile` uses a multi-stage build:
1. **Build stage**: Compiles the React app with Vite
2. **Runtime stage**: Serves the app with nginx on port 8080

### Nginx Configuration
The `frontend/nginx.conf` provides:
- SPA routing (all routes serve index.html)
- Static asset caching
- Security headers
- Gzip compression

## Cloud Run Configuration

Default settings in the workflow:
- **Port**: 8080
- **Memory**: 512Mi
- **CPU**: 1
- **Min instances**: 0 (scales to zero)
- **Max instances**: 10
- **Timeout**: 300s (5 minutes)
- **Public access**: Allowed (--allow-unauthenticated)

### Customizing Cloud Run Settings

Edit the deploy step in `.github/workflows/deploy-frontend.yml`:

```yaml
flags: |
  --allow-unauthenticated  # Remove for authenticated-only access
  --port=8080
  --memory=1Gi            # Increase memory if needed
  --cpu=2                 # Increase CPU if needed
  --min-instances=1       # Keep at least 1 instance warm
  --max-instances=20      # Allow more scaling
  --timeout=300s
```

## Environment Variables

To add environment variables to your Cloud Run service:

```yaml
- name: Deploy to Cloud Run
  uses: google-github-actions/deploy-cloudrun@v2
  with:
    service: ${{ env.SERVICE_NAME }}
    region: ${{ env.REGION }}
    image: ${{ needs.build-and-push.outputs.image-tag }}
    env_vars: |
      REACT_APP_API_URL=https://api.example.com
      REACT_APP_ENV=production
```

## Testing Locally

### Build and Test Docker Image

```bash
cd frontend

# Build the image
docker build -t prediction-dao-frontend:test .

# Run the container
docker run -p 8080:8080 prediction-dao-frontend:test

# Visit http://localhost:8080 in your browser
```

### Test with Cloud Run Emulator

```bash
# Install Cloud Run emulator
gcloud components install cloud-run-proxy

# Deploy locally
gcloud run deploy prediction-dao-frontend \
  --source=./frontend \
  --region=us-central1 \
  --local
```

## Monitoring and Logs

### View Deployment Status

1. GitHub Actions: **Actions** tab in your repository
2. Cloud Run Console: https://console.cloud.google.com/run

### View Application Logs

```bash
# Stream logs
gcloud run services logs tail prediction-dao-frontend \
  --region=us-central1

# View recent logs
gcloud run services logs read prediction-dao-frontend \
  --region=us-central1 \
  --limit=50
```

### Access the Deployed Service

After successful deployment, the service URL is displayed in the GitHub Actions logs:

```
Service URL: https://prediction-dao-frontend-xxxxx.a.run.app
```

## Troubleshooting

### Authentication Errors

**Error**: "Permission denied" or "Authentication failed"

**Solution**: Verify that:
- Service account has the required roles
- GitHub secrets are configured correctly
- Workload Identity Pool is properly set up (if using WIF)

### Build Failures

**Error**: Build fails during npm install or build

**Solution**: 
- Check `frontend/package.json` for correct dependencies
- Ensure Node.js version in Dockerfile matches your requirements
- Review build logs for specific error messages

### Deployment Failures

**Error**: "Service does not exist" or "Region not specified"

**Solution**:
- Verify `GCP_REGION` secret is set correctly
- Ensure Cloud Run API is enabled in your project
- Check that service name doesn't conflict with existing services

### Image Push Failures

**Error**: "denied: Permission denied" when pushing to Artifact Registry

**Solution**:
- Verify Artifact Registry repository exists
- Check service account has `artifactregistry.writer` role
- Ensure repository region matches `GCP_REGION`

## Security Best Practices

1. **Use Workload Identity Federation** instead of service account keys
2. **Limit service account permissions** to only what's needed
3. **Enable Cloud Armor** for DDoS protection
4. **Configure CORS** if the frontend calls external APIs
5. **Use Secret Manager** for sensitive configuration
6. **Enable VPC** for network isolation (advanced)
7. **Regular updates** of dependencies and base images

## Cost Optimization

Cloud Run pricing is based on:
- Request count
- CPU time
- Memory usage
- Outbound networking

Tips to reduce costs:
1. Set `min-instances=0` to scale to zero when idle
2. Right-size memory and CPU allocations
3. Use CDN for static assets (Cloud CDN)
4. Implement caching strategies
5. Monitor usage with Cloud Monitoring

## Advanced Configuration

### Custom Domain

1. **Map custom domain** in Cloud Run console
2. **Configure DNS** with your domain provider
3. **Enable Cloud CDN** for better performance

### CI/CD Environments

Create separate workflows for different environments:
- `deploy-frontend-staging.yml` → deploy to staging
- `deploy-frontend-production.yml` → deploy to production

### Multi-Region Deployment

Deploy to multiple regions for better availability:

```yaml
strategy:
  matrix:
    region: [us-central1, europe-west1, asia-east1]
```

## Support

For issues or questions:
- Check [GitHub Issues](https://github.com/chippr-robotics/fairwins-platform/issues)
- Review [Cloud Run documentation](https://cloud.google.com/run/docs)
- Check [GitHub Actions documentation](https://docs.github.com/en/actions)

## References

- [Google Cloud Run Documentation](https://cloud.google.com/run/docs)
- [Google Artifact Registry](https://cloud.google.com/artifact-registry/docs)
- [Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation)
- [GitHub Actions for Google Cloud](https://github.com/google-github-actions)
- [Docker Best Practices](https://docs.docker.com/develop/dev-best-practices/)
