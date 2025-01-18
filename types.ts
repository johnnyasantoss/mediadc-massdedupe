export interface MediaDCGroup {
    task_id: number;
    group_id: number;
    files: MediaDCFile[];
}
export interface MediaDCFile {
    size?: string;
    fileid: number;
    filename: string;
    filepath: string;
    filesize: number;
}
