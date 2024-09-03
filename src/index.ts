import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";
import nodemailer from "nodemailer";

dotenv.config();

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});
const lastWeekKeys = {
  2: "Last 2 weeks",
  4: "Last 4 weeks",
  12: "Last 12 weeks",
  24: "Last 24 weeks",
};

async function fetchAllCommits(
  repoOwner: string,
  repoName: string,
  since: string
) {
  let page = 1;
  let commits: any[] = [];
  while (true) {
    try {
      const response = await octokit.repos.listCommits({
        owner: repoOwner,
        repo: repoName,
        since: since,
        per_page: 100,
        page: page,
      });
      if (response.data.length === 0) break;
      commits = commits.concat(response.data);
      page++;
    } catch (error: any) {
      if (error.status === 409) {
        console.warn(
          `Repository ${repoName} is empty or has no commits since ${since}`
        );
        break;
      } else {
        throw error;
      }
    }
  }
  return commits;
}

async function fetchAllPullRequests(
  repoOwner: string,
  repoName: string,
  since: string
) {
  let page = 1;
  let pullRequests: any[] = [];
  while (true) {
    try {
      const response = await octokit.pulls.list({
        owner: repoOwner,
        repo: repoName,
        state: "all",
        since: since,
        per_page: 100,
        page: page,
      });
      if (response.data.length === 0) break;
      pullRequests = pullRequests.concat(response.data);
      page++;
    } catch (error: any) {
      if (error.status === 409) {
        console.warn(
          `Repository ${repoName} is empty or has no pull requests since ${since}`
        );
        break;
      } else {
        throw error;
      }
    }
  }
  return pullRequests;
}

async function aggregateMetrics(
  repoOwner: string,
  repoName: string,
  since: string
) {
  const commits = await fetchAllCommits(repoOwner, repoName, since);
  const pullRequests = await fetchAllPullRequests(repoOwner, repoName, since);

  const userMetrics: any = {};

  commits.forEach((commit) => {
    const author = commit.author?.login || "Unknown";
    userMetrics[author] = userMetrics[author] || {
      commits: 0,
      pullRequests: 0,
      reviews: 0,
    };
    userMetrics[author].commits += 1;
  });

  pullRequests.forEach((pr) => {
    const author = pr.user?.login || "Unknown";
    userMetrics[author] = userMetrics[author] || {
      commits: 0,
      pullRequests: 0,
      reviews: 0,
    };
    if (pr.created_at >= since) userMetrics[author].pullRequests += 1;
    if (pr.merged_at >= since)
      pr.requested_reviewers.forEach((prReviewUser: any) => {
        userMetrics[prReviewUser.login] = userMetrics[prReviewUser.login] || {
          commits: 0,
          pullRequests: 0,
          reviews: 0,
        };
        userMetrics[prReviewUser.login].reviews += 1;
      });
  });

  return userMetrics;
}

async function generateReport(repoOwner: string, repoName: string) {
  const periods = {
    [lastWeekKeys[2]]: new Date(
      Date.now() - 14 * 24 * 60 * 60 * 1000
    ).toISOString(),
    [lastWeekKeys[4]]: new Date(
      Date.now() - 28 * 24 * 60 * 60 * 1000
    ).toISOString(),
    [lastWeekKeys[12]]: new Date(
      Date.now() - 84 * 24 * 60 * 60 * 1000
    ).toISOString(),
    [lastWeekKeys[24]]: new Date(
      Date.now() - 168 * 24 * 60 * 60 * 1000
    ).toISOString(),
  };

  const report: any = {};
  for (const [label, since] of Object.entries(periods)) {
    const metrics = await aggregateMetrics(repoOwner, repoName, since);
    report[label] = metrics;
  }

  return report;
}

async function getAllRepositories(orgName: string) {
  let page = 1;
  let repos: any[] = [];
  while (true) {
    const response = await octokit.repos.listForOrg({
      org: orgName,
      per_page: 100,
      page: page,
    });
    if (response.data.length === 0) break;
    repos = repos.concat(response.data);
    page++;
  }
  return repos.map((repo) => repo.name);
}

async function sendEmail(subject: string, body: string) {
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
    to: "usama.ahmed@devbatch.com",
    subject: subject,
    html: body,
  };

  await transporter.sendMail(mailOptions);
}

function printProgress(i: number, N: number) {
  const barLength = 50;
  const progress = i / N;
  const filledLength = Math.round(barLength * progress);

  const bar = "#".repeat(filledLength) + "_".repeat(barLength - filledLength);
  const percentage = (progress * 100).toFixed(2);

  console.clear();
  console.log(`Progress: [${bar}] ${percentage}% (${i}/${N})`);
}

function prepareEmailBody(repoReports: any[]) {
  const finalReport: any = {};
  const weekKeys = Object.values(lastWeekKeys);
  Object.values(repoReports).forEach((repoData) => {
    weekKeys.forEach((key) => {
      Object.keys(repoData[key]).forEach((userKey) => {
        if (!finalReport[key]) {
          finalReport[key] = {};
        }
        if (finalReport[key][userKey]) {
          finalReport[key][userKey].commits += repoData[key][userKey].commits;
          finalReport[key][userKey].pullRequests +=
            repoData[key][userKey].pullRequests;
          finalReport[key][userKey].reviews += repoData[key][userKey].reviews;
        } else {
          finalReport[key][userKey] = repoData[key][userKey];
        }
      });
    });
  });
  return generateEmailTemplate(finalReport);
}
function generateEmailTemplate(data: any) {
  let emailTemplate = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>GitHub Metrics Report</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                margin: 0;
                padding: 20px;
                color: #333;
            }
            table {
                width: 100%;
                border-collapse: collapse;
                margin-top: 20px;
            }
            th, td {
                padding: 10px;
                border: 1px solid #ddd;
                text-align: center;
            }
            th {
                background-color: #f4f4f4;
            }
            tr:nth-child(even) {
                background-color: #f9f9f9;
            }
        </style>
    </head>
    <body>
        <h1>GitHub Metrics Report</h1>
        
        ${generateTableSection(lastWeekKeys[2], data[lastWeekKeys[2]])}
        ${generateTableSection(lastWeekKeys[4], data[lastWeekKeys[4]])}
        ${generateTableSection(lastWeekKeys[12], data[lastWeekKeys[12]])}
        ${generateTableSection(lastWeekKeys[24], data[lastWeekKeys[24]])}
    </body>
    </html>
    `;

  return emailTemplate;
}

function generateTableSection(title: string, sectionData: any) {
  let rows = Object.keys(sectionData)
    .map(
      (key) => `
        <tr>
            <td>${key}</td>
            <td>${sectionData[key].commits}</td>
            <td>${sectionData[key].pullRequests}</td>
            <td>${sectionData[key].reviews}</td>
        </tr>
    `
    )
    .join("");

  return `
    <h2>${title}</h2>
    <table>
        <thead>
            <tr>
                <th>User</th>
                <th>Commits</th>
                <th>Pull Requests</th>
                <th>Reviews</th>
            </tr>
        </thead>
        <tbody>
            ${rows}
        </tbody>
    </table>
    `;
}
(async () => {
  try {
    const repoOwner = "rapid-recovery-agency-inc";
    // const allRepoNames = await getAllRepositories(repoOwner);
    const allReports: any = {};

    const repoNames = await getAllRepositories(repoOwner);
    for (let i = 0; i < repoNames.length; i++) {
      const repoName = repoNames[i];
      const report = await generateReport(repoOwner, repoName);
      allReports[repoName] = report;
      printProgress(i + 1, repoNames.length);
    }

    const emailBody = prepareEmailBody(allReports);
    await sendEmail("GitHub Repositories Report", emailBody);

    console.log("Report sent successfully.");
  } catch (error) {
    console.error("Error:", error);
  }
})();
