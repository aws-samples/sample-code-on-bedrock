#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="codeonbedrock-cli-build"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="$PROJECT_NAME-$ACCOUNT_ID"
SOURCE_KEY="source.zip"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Creating S3 bucket for source & artifacts..."
if [ "$REGION" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null || true
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION" 2>/dev/null || true
fi

echo "==> Zipping source..."
TMPZIP=$(mktemp /tmp/source-XXXX).zip
(cd "$REPO_ROOT" && zip -rq "$TMPZIP" cli/ -x 'cli/codeonbedrock*')

echo "==> Uploading source to s3://$BUCKET/$SOURCE_KEY..."
aws s3 cp "$TMPZIP" "s3://$BUCKET/$SOURCE_KEY" --region "$REGION"
rm -f "$TMPZIP"

echo "==> Creating IAM role for CodeBuild..."
ROLE_NAME="$PROJECT_NAME-role"
TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "codebuild.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}'
ROLE_ARN=$(aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document "$TRUST_POLICY" \
  --query 'Role.Arn' --output text 2>/dev/null) || \
  ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)

POLICY='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],
      "Resource": "arn:aws:logs:*:*:*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject","s3:PutObject","s3:GetBucketLocation"],
      "Resource": ["arn:aws:s3:::'"$BUCKET"'","arn:aws:s3:::'"$BUCKET"'/*"]
    }
  ]
}'
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name "$PROJECT_NAME-policy" \
  --policy-document "$POLICY"

echo "==> Waiting for IAM role propagation..."
sleep 10

echo "==> Creating/updating CodeBuild project..."
if aws codebuild batch-get-projects --names "$PROJECT_NAME" --region "$REGION" \
    --query 'projects[0].name' --output text 2>/dev/null | grep -q "$PROJECT_NAME"; then
  echo "  Project exists, updating..."
  aws codebuild update-project \
    --name "$PROJECT_NAME" \
    --region "$REGION" \
    --source type=S3,location="$BUCKET/$SOURCE_KEY",buildspec=cli/buildspec.yml \
    --artifacts type=S3,location="$BUCKET",path=artifacts,packaging=ZIP \
    --environment type=LINUX_CONTAINER,computeType=BUILD_GENERAL1_SMALL,image=aws/codebuild/amazonlinux-x86_64-standard:5.0 \
    --service-role "$ROLE_ARN" \
    --no-cli-pager
else
  echo "  Creating new project..."
  aws codebuild create-project \
    --name "$PROJECT_NAME" \
    --region "$REGION" \
    --source type=S3,location="$BUCKET/$SOURCE_KEY",buildspec=cli/buildspec.yml \
    --artifacts type=S3,location="$BUCKET",path=artifacts,packaging=ZIP \
    --environment type=LINUX_CONTAINER,computeType=BUILD_GENERAL1_SMALL,image=aws/codebuild/amazonlinux-x86_64-standard:5.0 \
    --service-role "$ROLE_ARN" \
    --no-cli-pager
fi

echo "==> Starting build..."
BUILD_ID=$(aws codebuild start-build \
  --project-name "$PROJECT_NAME" \
  --region "$REGION" \
  --query 'build.id' --output text)

echo "Build started: $BUILD_ID"
echo "==> Waiting for build to complete..."

while true; do
  STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$REGION" \
    --query 'builds[0].buildStatus' --output text)
  echo "  Status: $STATUS"
  [ "$STATUS" != "IN_PROGRESS" ] && break
  sleep 15
done

if [ "$STATUS" = "SUCCEEDED" ]; then
  echo "==> Build succeeded! Downloading artifacts..."
  TMPART=$(mktemp /tmp/artifact-XXXX).zip
  aws s3 cp "s3://$BUCKET/artifacts/$PROJECT_NAME" "$TMPART" --region "$REGION"
  unzip -o "$TMPART" -d "$REPO_ROOT/cli/"
  rm -f "$TMPART"
  echo "Binaries saved to cli/"
  ls -lh "$REPO_ROOT/cli/codeonbedrock"* 2>/dev/null || true
else
  echo "==> Build failed. Check logs:"
  echo "  https://$REGION.console.aws.amazon.com/codesuite/codebuild/projects/$PROJECT_NAME/build/$BUILD_ID/log"
  exit 1
fi
