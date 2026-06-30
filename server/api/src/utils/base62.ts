const base62String: string = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function encodeToBase62(val: bigint) : string {
    let shortCode : string[] = [];
    if(val == 0n) return base62String.charAt(0);
    let temp : number = 0;
    while(val > 0) {
        temp = Number(val % 62n);
        shortCode.push(base62String.charAt(temp));
        val = val / 62n;
    }
    return shortCode.reverse().join("");
}

export function decodeBase62ToDecimal(str: string) : bigint | null {
    if(str.length == 0) return null;
    let tempArr : string[] = str.split("").reverse();
    let res: bigint = 0n; 
    for(let i=0; i<tempArr.length; ++i) {
        const char = tempArr[i];
        if(char === undefined) return null;
        const index = base62String.indexOf(char);
        if(index === -1) return null;
        res += BigInt(index) * (62n ** BigInt(i));
    }
    return res;
}