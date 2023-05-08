#ifndef CHDB_H
#define CHDB_H

#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

struct local_result
{
    char * buf;
    size_t len;
    void * _vec; // std::vector<char> *, for freeing
};

const char* ares_query(const char* queryStr, const char* format);
struct local_result* query_stable(int arg, char ** argv);
struct local_result * queryToBuffer(const char *queryStr, const char *format);

#ifdef __cplusplus
}
#endif

#endif
