#!/bin/bash

# Git Statistics and Progress Tracker
# Shows daily, weekly, and monthly commit statistics

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'
BOLD='\033[1m'

DAILY_GOAL=6
WEEKLY_GOAL=42  # 6 * 7

# Get commit counts
today=$(date +%Y-%m-%d)
today_commits=$(git log --oneline --since="$today 00:00:00" --until="$today 23:59:59" 2>/dev/null | wc -l | tr -d ' ')

week_start=$(date -v-sunday +%Y-%m-%d 2>/dev/null || date -d "last sunday" +%Y-%m-%d)
week_commits=$(git log --oneline --since="$week_start 00:00:00" 2>/dev/null | wc -l | tr -d ' ')

month_start=$(date +%Y-%m-01)
month_commits=$(git log --oneline --since="$month_start 00:00:00" 2>/dev/null | wc -l | tr -d ' ')

total_commits=$(git rev-list --count HEAD 2>/dev/null)

# Calculate streak
streak=0
check_date=$today
while true; do
    day_commits=$(git log --oneline --since="$check_date 00:00:00" --until="$check_date 23:59:59" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$day_commits" -ge "$DAILY_GOAL" ]; then
        ((streak++))
        check_date=$(date -v-1d -jf "%Y-%m-%d" "$check_date" +%Y-%m-%d 2>/dev/null || date -d "$check_date - 1 day" +%Y-%m-%d)
    else
        break
    fi
done

# Progress bar function
progress_bar() {
    local current=$1
    local goal=$2
    local width=30
    local percent=$((current * 100 / goal))
    if [ $percent -gt 100 ]; then percent=100; fi
    local filled=$((percent * width / 100))
    local empty=$((width - filled))

    local bar=""
    local color=$GREEN
    if [ $percent -lt 50 ]; then color=$RED
    elif [ $percent -lt 80 ]; then color=$YELLOW
    fi

    for ((i=0; i<filled; i++)); do bar="${bar}█"; done
    for ((i=0; i<empty; i++)); do bar="${bar}░"; done

    echo -e "${color}${bar}${NC} ${percent}%"
}

# Header
echo ""
echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║           📊 GIT STATISTICS & PROGRESS               ║${NC}"
echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# Today's Progress
echo -e "${BOLD}📅 TODAY ($today)${NC}"
echo -e "   Commits: ${GREEN}$today_commits${NC} / $DAILY_GOAL"
echo -n "   "
progress_bar $today_commits $DAILY_GOAL
if [ $today_commits -ge $DAILY_GOAL ]; then
    echo -e "   ${GREEN}✅ Daily goal achieved!${NC}"
else
    remaining=$((DAILY_GOAL - today_commits))
    echo -e "   ${YELLOW}📝 $remaining more commits needed${NC}"
fi
echo ""

# This Week's Progress
echo -e "${BOLD}📆 THIS WEEK (since $week_start)${NC}"
echo -e "   Commits: ${GREEN}$week_commits${NC} / $WEEKLY_GOAL"
echo -n "   "
progress_bar $week_commits $WEEKLY_GOAL
echo ""

# This Month's Progress
days_in_month=$(date +%d | sed 's/^0//')
month_goal=$((days_in_month * DAILY_GOAL))
echo -e "${BOLD}📅 THIS MONTH (since $month_start)${NC}"
echo -e "   Commits: ${GREEN}$month_commits${NC} / ~$month_goal (based on days passed)"
echo -n "   "
progress_bar $month_commits $month_goal
echo ""

# Streak
echo -e "${BOLD}🔥 CURRENT STREAK${NC}"
if [ $streak -gt 0 ]; then
    echo -e "   ${GREEN}$streak day(s)${NC} with $DAILY_GOAL+ commits"
else
    echo -e "   ${YELLOW}No streak yet. Make $DAILY_GOAL commits today to start!${NC}"
fi
echo ""

# Total commits
echo -e "${BOLD}📈 ALL TIME${NC}"
echo -e "   Total commits: ${GREEN}$total_commits${NC}"
echo ""

# Recent commits
echo -e "${BOLD}🕐 RECENT COMMITS${NC}"
git log --oneline -5 | while read line; do
    echo "   $line"
done
echo ""

# Unpushed commits
unpushed=$(git log @{u}..HEAD --oneline 2>/dev/null | wc -l | tr -d ' ')
if [ "$unpushed" -gt 0 ]; then
    echo -e "${YELLOW}⚠️  You have $unpushed unpushed commit(s)!${NC}"
    echo -e "${YELLOW}   Run 'git push' to sync with remote.${NC}"
    echo ""
fi

# Tips
echo -e "${CYAN}${BOLD}💡 QUICK TIPS${NC}"
echo "   • Run ./scripts/quick-commit.sh for easy commits"
echo "   • Use conventional commits: feat, fix, docs, chore, etc."
echo "   • Small, frequent commits are better than large ones"
echo ""
