# Continuous Sanity Chrome Extension

Capture in-context feedback while testing any staging, preview, or local web app. Feedback is attached to the page, element, and screenshot context, then appears in the Continuous Sanity session dashboard.

## Install in Chrome

1. Download this repository as a ZIP, or clone it locally.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** in the top-right corner.
4. Select **Load unpacked**.
5. Choose the folder containing this repository's `manifest.json` file.
6. Pin the Continuous Sanity extension if you want quick access from Chrome's toolbar.

## Join a test session

1. Open the Continuous Sanity side panel from the extension icon.
2. Open **Setup** and enter your team's server URL once. For the hosted service, use `https://app.continuoussanity.com/api`.
3. Enter the invite code supplied by the test lead and the name that should appear with your feedback.
4. Select **Join session**.
5. Browse the app being tested, then choose **Mark something on the page** and click the relevant element.
6. Add your observation and send it. The extension captures the current viewport with a pin at the selected element.

The test lead creates the invite code in the Continuous Sanity dashboard. Testers do not need dashboard access.

## Updating the extension

If you installed from a clone, pull the latest changes. Then return to `chrome://extensions` and select the extension's **Reload** button.

## Permissions

The extension requests access to the active tab, scripting, tabs, storage, and Chrome's side panel. It needs broad site access so the same capture flow can work on local development servers, preview deployments, and staging environments. It only collects feedback when a tester deliberately starts a capture.
