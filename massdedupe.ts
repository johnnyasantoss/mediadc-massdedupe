#!/usr/bin/env -S ./node_modules/.bin/tsx
import { AuthType, createClient, FileStat } from "webdav";
import { Command } from "@commander-js/extra-typings";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { MediaDCFile, MediaDCGroup } from "./types";
import isInteractive from "is-interactive";
import MultiSpinner from "multispinner";
import { readFile, writeFile } from "node:fs/promises";
import chalk from "chalk";
import path from "node:path";

// Argument parsing setup
const program = new Command("mediadc-massdedupe")
    .usage(`mediadc-massdedupe [options]... [--] <json file>`)
    .description(
        "Removes duplicates found with MediaDC extension on Nextcloud, leaving only one file (bigger, smaller path)"
    )
    .version("0.0.1")
    .requiredOption("-h --host <domain>", "WebDAV host domain (no http(s))")
    .requiredOption("-u --user <user>", "WebDAV login user")
    .requiredOption("-p --password <pass>", "Password for WebDAV account")
    .option("--port <number>", "WebDAV host port", parseInt, 443)
    .option("--proto <protocol>", "WebDAV protocol", "https")
    .option(
        "--path <value>",
        "WebDAV base path, if any",
        "remote.php/dav/files/{USER}"
    )
    .option(
        "--cache-info",
        "Cache info every 500 files read from Nextcloud",
        true
    )
    .option(
        "-x, --exclude <value...>",
        "Files to exclude from deletion (insensitive)",
        [] as string[]
    )
    .option(
        "-i, --include <value...>",
        "Files that the path contains this strings will be preferred for deletion (insensitive)",
        [] as string[]
    )
    .option(
        "-d, --dry-run",
        'perform a "dry run" which will not delete anything',
        false
    )
    .argument("<json file>", "path to json file generated by mediadc")
    .showHelpAfterError()
    .showSuggestionAfterError();

const args = program.parse().opts(),
    filePath = program.args[0],
    cachePath = filePath + ".cache",
    nextcloudUrl = `${args.proto}://${args.host}:${
        args.port
    }/${args.path.replace("{USER}", args.user)}`;

console.info("Starting with the following parameters", {
    ...args,
    password: "***",
    file: filePath,
    nextcloudUrl,
});

// Initialize WebDAV client
const webdavClient = createClient(nextcloudUrl, {
    authType: AuthType.Password,
    username: args.user,
    password: args.password,
});

async function remove(file: MediaDCFile): Promise<void> {
    try {
        const filePath = cleanupPath(file.filepath);
        console.info(`Deleting "${file.filepath}"...`);

        if (!args.dryRun) {
            await webdavClient.deleteFile(filePath);
        }
    } catch (error) {
        console.error(
            chalk.bgRedBright(
                `!!! Error occurred while deleting "${file.filepath}":`
            ),
            error
        );
    }
}

async function main() {
    // Load JSON data
    const dc = JSON.parse(readFileSync(filePath, "utf8"));

    if (
        !dc ||
        !dc.Task ||
        !dc.Results ||
        typeof dc !== "object" ||
        typeof dc.Task !== "object" ||
        !Array.isArray(dc.Results)
    ) {
        console.error(
            "Invalid json. Please use the exported data from mediadc in the json format."
        );
        process.exit(1);
    }

    console.info();
    console.info(`Starting filtering process for task "${dc.Task.name}"`);
    console.info(
        `Total files to be filtered ${
            dc.Task.files_total
        } with the size ${humanizeBytes(dc.Task.files_total_size)}`
    );
    console.info();

    const fileInfo = await getFilesInfo(dc.Results);

    printFileSummary(fileInfo);

    const exclude = [
            ...new Set<string>(args.exclude.map((e) => e.trim().toUpperCase())),
        ],
        include = [...new Set(args.include.map((i) => i.trim().toUpperCase()))];

    let deleted = 0,
        deletedSize = 0;

    for (const group of dc.Results as MediaDCGroup[]) {
        console.info(
            `Processing group ${group.group_id} (${group.files.length} files scanned)`
        );
        // Filter out entries that should be ignored based on trashbin etc.
        const files = group.files
            .filter((f) => fileInfo[f["filepath"]])
            .map((f) => {
                f.size = humanizeBytes(f.filesize);
                return f;
            })
            .sort((a, b) => {
                // file size asc, then file path len desc
                if (a.filesize > b.filesize) {
                    return -1;
                } else if (a.filesize < b.filesize) {
                    return 1;
                } else {
                    return a.filepath.length - b.filepath.length;
                }
            });

        if (!files.length) {
            console.info("No files left in this group");
            continue;
        }
        if (files.length === 1) {
            console.info("No duplicates in this group");
            continue;
        }

        const toDelete = new Map<number, string>();
        let firstNonIncludedWithSameSize = 0,
            keptOne = false;
        for (const [i, file] of files.entries()) {
            const upperCasePath = file.filepath.toUpperCase();
            if (exclude.some((e) => upperCasePath.includes(e))) {
                if (keptOne) {
                    // we already have one to keep
                    toDelete.set(file.fileid, "excluded-dupe");
                    continue;
                }

                console.info(
                    `File "${file.filepath}" is in exclude list. Skipping...`
                );
                keptOne = true;
                continue;
            }

            if (include.some((i) => upperCasePath.includes(i))) {
                // if this is the first and should be deleted, we try to keep the 2nd
                // if that file exists and is of equal size
                if (
                    i === firstNonIncludedWithSameSize &&
                    file.filesize === files[i + 1]?.filesize
                )
                    firstNonIncludedWithSameSize++;
                toDelete.set(file.fileid, "include");
                continue;
            }

            if (i > firstNonIncludedWithSameSize) {
                // this isn't the biggest file in the group
                toDelete.set(file.fileid, "smaller");
            } else {
                keptOne = true;
            }
        }

        const toDelLen = () => [...toDelete.keys()].length;
        if (files.length === toDelLen()) {
            console.warn(
                chalk.bgYellowBright(
                    "! All files are marked for deletion. Keeping the first file that doesn't match include list or the first if the whole list is included."
                )
            );
            const firstNonIncluded = files.findIndex(
                (f) =>
                    !include.some((i) => f.filepath.toUpperCase().includes(i))
            );
            const file =
                files[firstNonIncluded] ||
                files[firstNonIncludedWithSameSize] ||
                files[0];
            toDelete.delete(file.fileid);
        }

        if (toDelLen() === 0) {
            // maybe all files are excluded but one has to go
            // will delete the last
            console.warn(
                chalk.bgYellowBright(
                    "! No files to delete (maybe all excluded), keeping just the first."
                )
            );
            for (const file of files.slice(1)) {
                toDelete.set(file.fileid, "excluded-last");
            }
        }

        if (toDelLen() !== files.length - 1) {
            throw new Error("Sanity check. Should never happen");
        }

        console.info("\nGroup summary");
        for (const file of files) {
            const action = toDelete.has(file.fileid)
                    ? `deleted (${chalk.bgMagenta(toDelete.get(file.fileid))})`
                    : "kept",
                preText = toDelete.has(file.fileid)
                    ? chalk.redBright("X")
                    : chalk.greenBright("✓");
            console.info(
                `${preText} File "${file.filepath}" (${chalk.cyan(
                    file.size
                )}) will be ${action}`
            );
        }
        console.info();

        console.info(`Starting deletion...`);
        for (const file of files) {
            if (!toDelete.has(file.fileid)) continue;

            deleted++;
            deletedSize += file.filesize;
            await remove(file);
        }

        console.info(`Done processing group ${group.group_id}\n`);
    }

    console.info(chalk.bgGreenBright("✓ Finished deleting duplicates"));
    const groups: MediaDCGroup[] = dc.Results;
    console.info(`Processed ${groups.length} groups.`);
    const totalFiles = groups.reduce((p, c) => c.files.length + p, 0),
        totalFilesSize = groups.reduce(
            (p, c) => c.files.reduce((p, c) => c.filesize + p, 0) + p,
            0
        );
    console.info(
        `Deleted ${chalk.redBright(deleted.toString())} (${humanizeBytes(
            deletedSize
        )}) out of ${chalk.bgWhiteBright(totalFiles)} (${humanizeBytes(
            totalFilesSize
        )}) files.`
    );

    if (args.cacheInfo && existsSync(cachePath)) {
        if (args.dryRun) {
            console.info(
                `Leaving files info cached in ${path.relative(
                    process.cwd(),
                    cachePath
                )}`
            );
        } else {
            rmSync(cachePath);
        }
    }
}

async function getFilesInfo(
    groups: MediaDCGroup[]
): Promise<Record<string, false | FileStat>> {
    let fileInfo: Record<string, FileStat | false> = {};
    const spinnerText = "Getting files latest information...",
        interactive = isInteractive(),
        ms = interactive ? new MultiSpinner([spinnerText]) : null,
        spinner = ms?.spinners[spinnerText];

    if (args.cacheInfo && existsSync(cachePath)) {
        const contents = await readFile(cachePath, "utf8");
        const cacheData = JSON.parse(contents);
        fileInfo = cacheData || {};
    }
    const saveCacheData = async () => {
        if (!args.cacheInfo) return;
        return writeFile(cachePath, JSON.stringify({ ...fileInfo }), "utf8");
    };

    const totalFiles = groups.reduce((p, c) => c.files.length + p, 0);
    let i = 0;

    for (const group of groups) {
        for (const file of group.files) {
            i++;
            if (file.filepath in fileInfo) continue;

            if (i % 500 === 0) {
                await saveCacheData();
            }
            if (file.filepath.startsWith("files_trashbin")) {
                fileInfo[file.filepath] = false;
                continue;
            }

            const progress = ((100 * i) / totalFiles).toFixed(2);
            if (interactive) {
                spinner.text = `Getting info for "${i}/${totalFiles}"... ${progress}%`;
            } else {
                console.info(
                    `Getting info for "${file.filepath}" - ${progress}% done`
                );
            }

            try {
                // removes the "files/"
                const filePath = cleanupPath(file.filepath);
                const info = await webdavClient.stat(filePath);
                fileInfo[file.filepath] = info as FileStat;
            } catch (error) {
                fileInfo[file.filepath] = false;
                console.warn(
                    `Failed to get info for "${file.filepath}" - ${
                        (error as any).message
                    }\n`
                );
            }
        }
    }

    ms?.success(spinnerText);

    await saveCacheData();

    return fileInfo;
}

main().catch((e: Error) => {
    console.error("Error", e);
});

function cleanupPath(file: string) {
    return file.startsWith("files/")
        ? file.split("/").slice(1).join("/")
        : file;
}

function humanizeBytes(bytes: number): string {
    if (bytes >= Math.pow(1024, 4)) {
        return (bytes / Math.pow(1024, 4)).toFixed(2) + " TiB";
    }
    if (bytes >= Math.pow(1024, 3)) {
        return (bytes / Math.pow(1024, 3)).toFixed(2) + " GiB";
    }
    if (bytes >= Math.pow(1024, 2)) {
        return (bytes / Math.pow(1024, 2)).toFixed(2) + " MiB";
    }
    if (bytes > 1024) {
        return (bytes / 1024).toFixed(2) + " KiB";
    }
    return bytes + " B";
}

function printFileSummary(filesInfo: Record<string, false | FileStat>) {
    const fileMap: any = getNewFileMap("base");

    for (const filePath in filesInfo) {
        const fileInfo = filesInfo[filePath];
        if (!fileInfo) continue;

        let prevPart = "";
        let prevMap = fileMap,
            currentMap = fileMap;

        const parts = cleanupPath(filePath).split("/");
        for (const [index, part] of parts.entries()) {
            if (index === parts.length - 1) continue;

            prevMap = prevPart ? prevMap[prevPart] : prevMap;
            currentMap = prevMap[part] || getNewFileMap(part);
            prevMap[part] = currentMap;

            prevPart = part;
        }

        currentMap.files = (currentMap.files || 0) + 1;
    }

    printMap("", fileMap);

    function getNewFileMap(name: string) {
        return {
            name,
            get count() {
                let count = this.files || 0;

                for (const key in this) {
                    if (["count", "name", "files"].includes(key)) continue;
                    if (!Object.prototype.hasOwnProperty.call(this, key))
                        continue;

                    const children = this[key];
                    if (typeof children !== "object") continue;
                    if (!("count" in children)) continue;

                    count += children.count;
                }

                return count;
            },
            files: 0,
        };
    }

    function printMap(indent: string, fileMap: object) {
        for (const key in fileMap) {
            if (["count", "name", "files"].includes(key)) continue;
            if (!Object.prototype.hasOwnProperty.call(fileMap, key)) continue;

            const children = fileMap[key];
            if (typeof children !== "object") continue;
            if (!("count" in children)) continue;

            console.info(`${indent}-> ${children.name}: ${children.count}`);
            printMap(indent + "  ", children);
        }
    }
}

