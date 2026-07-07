#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"

echo "=== Fetching WebStack outputs ==="
BUCKET=$(aws cloudformation describe-stacks --stack-name WebStack --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`WebBucketName`].OutputValue' --output text)
DIST_ID=$(aws cloudformation describe-stacks --stack-name WebStack --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionId`].OutputValue' --output text)

echo "  bucket : $BUCKET"
echo "  dist   : $DIST_ID"

echo "=== Building web UI ==="
(cd web && npm run build)

echo "=== Syncing to S3 ==="
aws s3 sync web/out "s3://$BUCKET" --delete --region "$REGION"

echo "=== Invalidating CloudFront ==="
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" --query 'Invalidation.Id' --output text

echo "=== Done ==="
