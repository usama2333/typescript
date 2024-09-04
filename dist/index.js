import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import cron from "node-cron";
import xlsx from "xlsx";
// Load environment variables from a .env file into process.env
dotenv.config();
// Initialize Octokit instance with GitHub token for authentication
const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
});
// Map of time periods for metrics reporting
const lastWeekKeys = {
    2: "Last 2 weeks",
    4: "Last 4 weeks",
    12: "Last 12 weeks",
    24: "Last 24 weeks",
};
// Function to fetch all commits from a repository since a specified date
async function fetchAllCommits(repoOwner, repoName, since) {
    let page = 1;
    let commits = [];
    while (true) {
        try {
            const response = await octokit.repos.listCommits({
                owner: repoOwner,
                repo: repoName,
                since: since,
                per_page: 100,
                page: page,
            });
            if (response.data.length === 0)
                break; // No more commits to fetch
            commits = commits.concat(response.data);
            page++;
        }
        catch (error) {
            if (error.status === 409) {
                console.warn(`Repository ${repoName} is empty or has no commits since ${since}`);
                break;
            }
            else if (error.status === 403) {
                console.log("Rate limit exceeded. Retrying...");
                await new Promise(resolve => setTimeout(resolve, 60000)); // Wait 60 seconds before retrying
            }
            else {
                throw error; // Propagate unexpected errors
            }
        }
    }
    return commits;
}
// Function to fetch all pull requests from a repository since a specified date
async function fetchAllPullRequests(repoOwner, repoName, since) {
    let page = 1;
    let pullRequests = [];
    while (true) {
        try {
            const response = await octokit.pulls.list({
                owner: repoOwner,
                repo: repoName,
                state: "all",
                per_page: 100,
                page: page,
            });
            if (response.data.length === 0)
                break; // No more pull requests to fetch
            pullRequests = pullRequests.concat(response.data);
            page++;
        }
        catch (error) {
            if (error.status === 409) {
                console.warn(`Repository ${repoName} is empty or has no pull requests since ${since}`);
                break;
            }
            else if (error.status === 403) {
                console.log("Rate limit exceeded. Retrying...");
                await new Promise(resolve => setTimeout(resolve, 60000)); // Wait 60 seconds before retrying
            }
            else {
                throw error; // Propagate unexpected errors
            }
        }
    }
    return pullRequests;
}
// Function to aggregate metrics from commits and pull requests
async function aggregateMetrics(repoOwner, repoName, since) {
    const commits = await fetchAllCommits(repoOwner, repoName, since);
    const pullRequests = await fetchAllPullRequests(repoOwner, repoName, since);
    const userMetrics = {};
    // Aggregate commit metrics by user
    commits.forEach((commit) => {
        const author = commit.author?.login || "Unknown";
        userMetrics[author] = userMetrics[author] || {
            commits: 0,
            pullRequests: 0,
            reviews: 0,
            score: 0,
        };
        userMetrics[author].commits += 1;
        userMetrics[author].score += 0.1; // Adjust scoring based on feedback
    });
    // Aggregate pull request metrics by user
    pullRequests.forEach((pr) => {
        const author = pr.user?.login || "Unknown";
        userMetrics[author] = userMetrics[author] || {
            commits: 0,
            pullRequests: 0,
            reviews: 0,
            score: 0,
        };
        userMetrics[author].pullRequests += 1;
        userMetrics[author].score += 1; // Each PR adds 1 to the score
        if (pr.requested_reviewers && pr.requested_reviewers.length > 0) {
            pr.requested_reviewers.forEach((reviewer) => {
                userMetrics[reviewer.login] = userMetrics[reviewer.login] || {
                    commits: 0,
                    pullRequests: 0,
                    reviews: 0,
                    score: 0,
                };
                userMetrics[reviewer.login].reviews += 1;
                userMetrics[reviewer.login].score += 0.1; // Each review comment adds 0.1 to the score
            });
        }
    });
    return userMetrics;
}
// Function to generate a report for all repositories in specified periods
async function generateReportForAllRepos(repoOwner, repos) {
    const periods = {
        [lastWeekKeys[2]]: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        [lastWeekKeys[4]]: new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString(),
        [lastWeekKeys[12]]: new Date(Date.now() - 84 * 24 * 60 * 60 * 1000).toISOString(),
        [lastWeekKeys[24]]: new Date(Date.now() - 168 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const aggregateReport = {};
    // for (const [label, since] of Object.entries(periods)) {
    //   const periodMetrics: any = {};
    //   for (const repoName of repos) {
    //     const metrics = await aggregateMetrics(repoOwner, repoName, since);
    //     for (const [user, userMetric] of Object.entries(metrics)) {
    //       if (!periodMetrics[user]) {
    //         periodMetrics[user] = {
    //           commits: 0,
    //           pullRequests: 0,
    //           reviews: 0,
    //           score: 0,
    //         };
    //       }
    //       periodMetrics[user].commits += userMetric.commits;
    //       periodMetrics[user].pullRequests += userMetric.pullRequests;
    //       periodMetrics[user].reviews += userMetric.reviews;
    //       periodMetrics[user].score += userMetric.score;
    //     }
    //   }
    //   aggregateReport[label] = periodMetrics;
    // }
    for (const [label, since] of Object.entries(periods)) {
        const periodMetrics = {};
        for (const repoName of repos) {
            const metrics = await aggregateMetrics(repoOwner, repoName, since);
            for (const [user, userMetric] of Object.entries(metrics)) {
                const metric = userMetric; // Typecast userMetric
                if (!periodMetrics[user]) {
                    periodMetrics[user] = {
                        commits: 0,
                        pullRequests: 0,
                        reviews: 0,
                        score: 0,
                    };
                }
                periodMetrics[user].commits += metric.commits;
                periodMetrics[user].pullRequests += metric.pullRequests;
                periodMetrics[user].reviews += metric.reviews;
                periodMetrics[user].score += metric.score;
            }
        }
        aggregateReport[label] = periodMetrics;
    }
    return aggregateReport;
}
// Function to get all repository names for an organization
async function getAllRepositories(orgName) {
    let page = 1;
    let repos = [];
    while (true) {
        const response = await octokit.repos.listForOrg({
            org: orgName,
            per_page: 100,
            page: page,
        });
        if (response.data.length === 0)
            break; // No more repositories to fetch
        repos = repos.concat(response.data);
        page++;
    }
    return repos.map((repo) => repo.name); // Return only repository names
}
// Function to send an email with the metrics report and attach an XLS file
async function sendEmailWithAttachment(subject, body, attachment) {
    const transporter = nodemailer.createTransport({
        service: process.env.EMAIL_SERVICE,
        secure: false,
        host: process.env.EMAIL_HOST,
        port: +(process.env.EMAIL_PORT || 587),
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD,
        },
    });
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_METRICS_TO_USER,
        subject: subject,
        html: body,
        attachments: [
            {
                filename: 'GitHub_Metrics_Report.xlsx',
                content: attachment,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            }
        ]
    };
    await transporter.sendMail(mailOptions);
    console.log("Email Successfully Sent with Attachment!!!");
}
// Function to convert the report data into an XLS buffer
function convertReportToXLS(report) {
    const sheetData = [];
    Object.entries(report).forEach(([period, metrics]) => {
        sheetData.push([period]);
        sheetData.push(['User', 'Commits', 'Pull Requests', 'Reviews', 'Score']);
        Object.entries(metrics).forEach(([user, data]) => {
            sheetData.push([
                user,
                data.commits,
                data.pullRequests,
                data.reviews,
                data.score,
            ]);
        });
        sheetData.push([]);
    });
    const worksheet = xlsx.utils.aoa_to_sheet(sheetData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Metrics Report');
    return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}
// Function to generate and email the report for all repositories
async function generateAndEmailReport() {
    const repoOwner = "rapid-recovery-agency-inc"; // Update with actual repo owner
    const repos = await getAllRepositories(repoOwner);
    const report = await generateReportForAllRepos(repoOwner, repos);
    const xlsBuffer = convertReportToXLS(report);
    await sendEmailWithAttachment("GitHub Metrics Report", "Attached is the GitHub metrics report.", xlsBuffer);
}
generateAndEmailReport();
// Schedule the task to run every Monday at 8 AM
cron.schedule("0 8 * * 1", generateAndEmailReport);
