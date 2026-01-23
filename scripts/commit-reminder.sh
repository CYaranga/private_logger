#!/bin/bash

# Commit Reminder Script for macOS
# Sends a notification if daily commit goal is not met
# Can be scheduled via launchd or cron

PROJECT_DIR="/Users/chrisyaranga/Documents/EulerInnovations/private_logger"
DAILY_GOAL=6

cd "$PROJECT_DIR" || exit 1

# Get today's commit count
today=$(date +%Y-%m-%d)
commits=$(git log --oneline --since="$today 00:00:00" --until="$today 23:59:59" 2>/dev/null | wc -l | tr -d ' ')
remaining=$((DAILY_GOAL - commits))

# Get current hour
hour=$(date +%H)

# Build notification message
if [ $commits -ge $DAILY_GOAL ]; then
    title="Git Goal Achieved!"
    message="You've made $commits commits today. Great work!"
    sound="Glass"
elif [ $commits -eq 0 ]; then
    title="No Commits Today!"
    message="You haven't made any commits yet. Time to code!"
    sound="Basso"
else
    title="Commit Reminder"
    message="You've made $commits commits today. $remaining more to reach your goal of $DAILY_GOAL."
    sound="Purr"
fi

# Send macOS notification
osascript -e "display notification \"$message\" with title \"$title\" sound name \"$sound\""

# Log the reminder
echo "$(date): $title - $message" >> "$PROJECT_DIR/scripts/reminder.log"
