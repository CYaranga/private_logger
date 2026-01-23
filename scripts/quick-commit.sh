#!/bin/bash

# Quick Commit Helper Script
# Makes it easy to create frequent, meaningful commits
# Usage: ./scripts/quick-commit.sh [type] [scope] [message]
# Or run interactively without arguments

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Commit types
TYPES=("feat" "fix" "docs" "style" "refactor" "test" "chore" "perf" "ci" "build")

# Get today's commit count
get_today_commits() {
    local today=$(date +%Y-%m-%d)
    local count=$(git log --oneline --since="$today 00:00:00" --until="$today 23:59:59" 2>/dev/null | wc -l | tr -d ' ')
    echo "$count"
}

# Show commit progress
show_progress() {
    local commits=$(get_today_commits)
    local goal=6
    local remaining=$((goal - commits))

    echo ""
    echo -e "${CYAN}📊 Daily Commit Progress${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "Today's commits: ${GREEN}$commits${NC} / ${goal}"

    if [ $commits -ge $goal ]; then
        echo -e "${GREEN}🎉 Goal achieved! Great job!${NC}"
    else
        echo -e "${YELLOW}📝 $remaining more commits to reach daily goal${NC}"
    fi
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

# Show current changes
show_changes() {
    echo -e "${CYAN}📁 Current Changes:${NC}"
    echo ""
    git status --short
    echo ""
}

# Interactive mode
interactive_commit() {
    show_progress
    show_changes

    # Check if there are changes to commit
    if [ -z "$(git status --porcelain)" ]; then
        echo -e "${YELLOW}No changes to commit. Make some changes first!${NC}"
        exit 0
    fi

    # Select type
    echo -e "${CYAN}Select commit type:${NC}"
    for i in "${!TYPES[@]}"; do
        case "${TYPES[$i]}" in
            feat)     desc="A new feature" ;;
            fix)      desc="A bug fix" ;;
            docs)     desc="Documentation only changes" ;;
            style)    desc="Formatting, missing semi colons, etc" ;;
            refactor) desc="Code change that neither fixes a bug nor adds a feature" ;;
            test)     desc="Adding missing tests" ;;
            chore)    desc="Maintain, dependencies, configs" ;;
            perf)     desc="Performance improvement" ;;
            ci)       desc="CI/CD changes" ;;
            build)    desc="Build system or external dependencies" ;;
        esac
        echo -e "  ${GREEN}$((i+1))${NC}) ${TYPES[$i]} - $desc"
    done

    echo ""
    read -p "Enter number (1-${#TYPES[@]}): " type_num

    if ! [[ "$type_num" =~ ^[0-9]+$ ]] || [ "$type_num" -lt 1 ] || [ "$type_num" -gt ${#TYPES[@]} ]; then
        echo -e "${RED}Invalid selection${NC}"
        exit 1
    fi

    type="${TYPES[$((type_num-1))]}"

    # Optional scope
    echo ""
    read -p "Enter scope (backend/frontend/api/ui) or press Enter to skip: " scope

    # Message
    echo ""
    read -p "Enter commit message: " message

    if [ -z "$message" ]; then
        echo -e "${RED}Commit message cannot be empty${NC}"
        exit 1
    fi

    # Build commit message
    if [ -n "$scope" ]; then
        commit_msg="$type($scope): $message"
    else
        commit_msg="$type: $message"
    fi

    # Confirm
    echo ""
    echo -e "${CYAN}Commit message:${NC} $commit_msg"
    echo ""
    read -p "Stage all changes and commit? (Y/n): " confirm

    if [[ "$confirm" =~ ^[Nn]$ ]]; then
        echo "Aborted."
        exit 0
    fi

    # Stage and commit
    git add -A
    git commit -m "$commit_msg"

    echo ""
    echo -e "${GREEN}✅ Commit successful!${NC}"
    show_progress

    # Offer to push
    read -p "Push to remote? (Y/n): " push_confirm
    if [[ ! "$push_confirm" =~ ^[Nn]$ ]]; then
        git push
        echo -e "${GREEN}✅ Pushed to remote!${NC}"
    fi
}

# Quick commit with arguments
quick_commit() {
    local type=$1
    local scope=$2
    local message=$3

    # Validate type
    local valid=false
    for t in "${TYPES[@]}"; do
        if [ "$t" == "$type" ]; then
            valid=true
            break
        fi
    done

    if [ "$valid" == false ]; then
        echo -e "${RED}Invalid commit type: $type${NC}"
        echo "Valid types: ${TYPES[*]}"
        exit 1
    fi

    # Build message
    if [ -n "$scope" ]; then
        commit_msg="$type($scope): $message"
    else
        commit_msg="$type: $message"
    fi

    git add -A
    git commit -m "$commit_msg"

    echo -e "${GREEN}✅ Committed: $commit_msg${NC}"
    show_progress
}

# Main
if [ $# -eq 0 ]; then
    interactive_commit
elif [ $# -eq 2 ]; then
    quick_commit "$1" "" "$2"
elif [ $# -eq 3 ]; then
    quick_commit "$1" "$2" "$3"
else
    echo "Usage: $0 [type] [scope] [message]"
    echo "Or run without arguments for interactive mode"
    echo ""
    echo "Examples:"
    echo "  $0                           # Interactive mode"
    echo "  $0 feat 'add login button'   # Quick commit without scope"
    echo "  $0 fix api 'handle errors'   # Quick commit with scope"
    exit 1
fi
