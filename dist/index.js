import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';
dotenv.config();
const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
});
async function fetchAllCommits(repoOwner, repoName, since) {
    let page = 1;
    let commits = [];
    while (true) {
        const response = await octokit.repos.listCommits({
            owner: repoOwner,
            repo: repoName,
            since: since,
            per_page: 100,
            page: page
        });
        if (response.data.length === 0)
            break;
        commits = commits.concat(response.data);
        page++;
    }
    return commits;
}
async function fetchAllPullRequests(repoOwner, repoName, since) {
    let page = 1;
    let pullRequests = [];
    while (true) {
        const response = await octokit.pulls.list({
            owner: repoOwner,
            repo: repoName,
            state: 'all',
            since: since,
            per_page: 100,
            page: page
        });
        if (response.data.length === 0)
            break;
        pullRequests = pullRequests.concat(response.data);
        page++;
    }
    return pullRequests;
}
async function getPullRequestReviews(repoOwner, repoName, pullNumber) {
    const reviews = await octokit.pulls.listReviews({
        owner: repoOwner,
        repo: repoName,
        pull_number: pullNumber,
    });
    return reviews.data;
}
async function aggregateMetrics(repoOwner, repoName, since) {
    const commits = await fetchAllCommits(repoOwner, repoName, since);
    const pullRequests = await fetchAllPullRequests(repoOwner, repoName, since);
    console.log('Commits:', commits);
    console.log('Pull Requests:', pullRequests);
    const userMetrics = {};
    commits.forEach(commit => {
        const author = commit.author?.login || 'Unknown';
        userMetrics[author] = userMetrics[author] || { commits: 0, pullRequests: 0, reviews: 0 };
        userMetrics[author].commits += 1;
    });
    pullRequests.forEach(pr => {
        const author = pr.user?.login || 'Unknown';
        userMetrics[author] = userMetrics[author] || { commits: 0, pullRequests: 0, reviews: 0 };
        userMetrics[author].pullRequests += 1;
    });
    console.log('User Metrics:', userMetrics);
    return userMetrics;
}
async function generateReport(repoOwner, repoName) {
    const periods = {
        'Last 2 weeks': new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        'Last 4 weeks': new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString(),
        'Last 12 weeks': new Date(Date.now() - 84 * 24 * 60 * 60 * 1000).toISOString(),
        'Last 24 weeks': new Date(Date.now() - 168 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const report = {};
    for (const [label, since] of Object.entries(periods)) {
        report[label] = await aggregateMetrics(repoOwner, repoName, since);
    }
    return report;
}
(async () => {
    try {
        const report = await generateReport('rapid-recovery-agency-inc', 'foundd-js');
        console.log('Report:', report);
    }
    catch (error) {
        console.error('Error:', error);
    }
})();
