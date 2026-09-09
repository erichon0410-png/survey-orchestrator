param (
    [Parameter(Position=0)]
    [ValidateSet("start", "up", "stop", "down", "restart", "status", "probe")]
    [string]$Action = "status"
)

wsl -d Ubuntu bash -c "cd /home/erich/workspace/survey-orchestrator && ./fleet.sh $Action"