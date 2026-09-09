param (
    [Parameter(Position=0)]
    [ValidateSet("start", "up", "stop", "down", "restart", "status", "probe")]
    [string]$Action = "status"
)

# WSL repo path; override with $env:SURVEY_REPO if the checkout lives elsewhere.
$Repo = if ($env:SURVEY_REPO) { $env:SURVEY_REPO } else { "/home/erich/workspace/survey-orchestrator" }

wsl -d Ubuntu bash -c "cd '$Repo' && ./fleet.sh $Action"